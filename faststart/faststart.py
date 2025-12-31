import os
import struct
import subprocess
import sys
import time
from pathlib import Path


def log(message: str) -> None:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"{now} droppr-faststart: {message}", flush=True)


def wait_for_stable_size(path: Path, *, interval_seconds: float = 2.0, timeout_seconds: float = 120.0) -> bool:
    deadline = time.time() + timeout_seconds
    last_size: int | None = None
    stable_count = 0

    while time.time() < deadline:
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return False

        if size == last_size and size > 0:
            stable_count += 1
            if stable_count >= 2:
                return True
        else:
            stable_count = 0
            last_size = size

        time.sleep(interval_seconds)

    return False


def find_top_level_atom_offsets(path: Path) -> dict[str, int]:
    offsets: dict[str, int] = {}

    with path.open("rb") as f:
        file_size = os.fstat(f.fileno()).st_size
        offset = 0

        while offset + 8 <= file_size:
            header = f.read(8)
            if len(header) < 8:
                break

            atom_size = struct.unpack(">I", header[:4])[0]
            atom_type = header[4:8].decode("ascii", errors="replace")
            header_size = 8

            if atom_size == 1:
                ext = f.read(8)
                if len(ext) < 8:
                    break
                atom_size = struct.unpack(">Q", ext)[0]
                header_size = 16
            elif atom_size == 0:
                atom_size = file_size - offset

            if atom_type in ("moov", "mdat") and atom_type not in offsets:
                offsets[atom_type] = offset
                if "moov" in offsets and "mdat" in offsets:
                    return offsets

            if atom_size < header_size:
                break

            f.seek(atom_size - header_size, 1)
            offset += atom_size

    return offsets


def get_video_codec(path: Path) -> str | None:
    """Get the video codec of a file using ffprobe."""
    try:
        cmd = [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            return result.stdout.strip().lower()
    except Exception:
        pass
    return None


def has_extra_data_streams(path: Path) -> bool:
    """Check if video has extra data streams that can cause playback issues."""
    try:
        cmd = [
            "ffprobe",
            "-v", "error",
            "-show_entries", "stream=codec_type",
            "-of", "csv=p=0",
            str(path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            streams = result.stdout.strip().split('\n')
            data_count = sum(1 for s in streams if s == 'data' or s == 'unknown')
            if data_count > 0:
                return True
    except Exception:
        pass
    return False


def has_timestamp_errors(path: Path) -> bool:
    """Check if video has timestamp/dts errors that cause playback issues."""
    try:
        cmd = [
            "ffmpeg",
            "-v", "error",
            "-i", str(path),
            "-f", "null",
            "-t", "10",  # Only check first 10 seconds for speed
            "-",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        stderr = result.stderr.lower()
        # Check for common timestamp issues
        if "non monotonically increasing dts" in stderr:
            return True
        if "invalid dts" in stderr:
            return True
        if "discarding invalid" in stderr:
            return True
    except Exception:
        pass
    return False


def fix_video_errors(path: Path) -> bool:
    """Re-encode video to fix timestamp and other errors."""
    tmp_path = path.with_name(f".{path.stem}.fixed{path.suffix}")
    try:
        st = path.stat()
    except FileNotFoundError:
        return False

    try:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-i", str(path),
            "-map", "0:v:0",  # Only first video stream
            "-map", "0:a:0?",  # Only first audio stream (optional)
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-c:a", "aac",
            "-movflags", "+faststart",
            str(tmp_path),
        ]
        log(f"fixing video errors: {path.name}")
        subprocess.run(cmd, check=True, timeout=3600)

        os.chmod(tmp_path, st.st_mode)
        os.replace(tmp_path, path)
        log(f"video fixed: {path.name}")
        return True
    except subprocess.TimeoutExpired:
        log(f"fix timed out: {path.name}")
    except Exception as exc:
        log(f"fix failed for {path.name}: {exc}")

    try:
        tmp_path.unlink(missing_ok=True)
    except Exception:
        pass
    return False


def transcode_hevc_to_h264(path: Path) -> bool:
    """Transcode HEVC video to H.264 for browser compatibility."""
    tmp_path = path.with_name(f".{path.stem}.h264{path.suffix}")
    try:
        st = path.stat()
    except FileNotFoundError:
        return False

    try:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-i", str(path),
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "23",
            "-c:a", "aac",
            "-movflags", "+faststart",
            str(tmp_path),
        ]
        log(f"transcoding HEVC to H.264: {path.name}")
        subprocess.run(cmd, check=True, timeout=3600)  # 1 hour timeout

        os.chmod(tmp_path, st.st_mode)
        os.replace(tmp_path, path)
        log(f"transcoding complete: {path.name}")
        return True
    except subprocess.TimeoutExpired:
        log(f"transcoding timed out: {path.name}")
    except Exception as exc:
        log(f"transcoding failed for {path.name}: {exc}")

    try:
        tmp_path.unlink(missing_ok=True)
    except Exception:
        pass
    return False


def faststart_in_place(path: Path) -> bool:
    tmp_path = path.with_name(f".{path.stem}.faststart{path.suffix}")
    try:
        st = path.stat()
    except FileNotFoundError:
        return False

    try:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(path),
            "-map",
            "0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(tmp_path),
        ]
        subprocess.run(cmd, check=True)

        os.chmod(tmp_path, st.st_mode)
        os.utime(tmp_path, (st.st_atime, st.st_mtime))

        os.replace(tmp_path, path)
        return True
    except Exception as exc:
        log(f"faststart failed for {path.name}: {exc}")
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
        return False


def main() -> int:
    if len(sys.argv) != 2:
        log("usage: faststart.py <path>")
        return 2

    path = Path(sys.argv[1])

    try:
        if not path.is_file():
            return 0
    except OSError:
        return 0

    if not wait_for_stable_size(path):
        log(f"skipping (file not stable): {path.name}")
        return 0

    try:
        offsets = find_top_level_atom_offsets(path)
    except PermissionError:
        log(f"skipping (permission denied): {path.name}")
        return 0
    except Exception as exc:
        log(f"skipping (failed to inspect atoms): {path.name}: {exc}")
        return 0
    moov_offset = offsets.get("moov")
    mdat_offset = offsets.get("mdat")

    # First check for HEVC and transcode to H.264 for browser compatibility
    codec = get_video_codec(path)
    if codec in ("hevc", "h265"):
        log(f"detected HEVC codec, transcoding to H.264: {path.name}")
        transcode_hevc_to_h264(path)
        return 0  # transcoding already includes faststart

    # Check for extra data streams (iPhone metadata) that cause playback issues
    if has_extra_data_streams(path):
        log(f"detected extra data streams: {path.name}")
        fix_video_errors(path)
        return 0  # re-encoding strips extra streams and includes faststart

    # Check for timestamp errors that cause playback/seeking issues
    if has_timestamp_errors(path):
        log(f"detected timestamp errors: {path.name}")
        fix_video_errors(path)
        return 0  # re-encoding includes faststart

    if moov_offset is None or mdat_offset is None:
        return 0

    if moov_offset < mdat_offset:
        return 0

    log(f"optimizing for streaming (moov after mdat): {path.name}")
    ok = faststart_in_place(path)
    if ok:
        log(f"done: {path.name}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
