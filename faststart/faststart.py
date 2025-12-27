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
