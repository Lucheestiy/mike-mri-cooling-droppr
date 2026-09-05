import hashlib
import os
import tempfile
import unittest
from unittest import mock


TEST_ROOT = tempfile.mkdtemp(prefix="droppr-resumable-tests-")
os.environ["DROPPR_FILEBROWSER_ROOT"] = os.path.join(TEST_ROOT, "files")
os.environ["DROPPR_UPLOAD_REQUESTS_DB_PATH"] = os.path.join(TEST_ROOT, "upload-requests.sqlite3")
os.environ["DROPPR_UPLOAD_SESSION_ROOT"] = os.path.join(TEST_ROOT, "sessions")
os.environ["DROPPR_UPLOAD_SESSION_CHUNK_SIZE_BYTES"] = str(5 * 1024 * 1024)
os.environ["DROPPR_UPLOAD_SESSION_MAX_CHUNK_SIZE_BYTES"] = str(64 * 1024 * 1024)
os.environ["DROPPR_UPLOAD_SESSION_MIN_FREE_BYTES"] = "0"
os.environ["DROPPR_UPLOAD_REQUEST_HARD_MAX_FILE_MB"] = "204800"

import app as server  # noqa: E402


class ResumableUploadTests(unittest.TestCase):
    def setUp(self):
        os.makedirs(os.path.join(server.FILEBROWSER_ROOT, "incoming"), exist_ok=True)
        self.request_id = server._generate_upload_request_id()
        with server._upload_requests_conn() as conn:
            conn.execute(
                """
                INSERT INTO upload_requests (
                    request_id, dest_path, target_path, title, password_hash, expires_at,
                    max_files, max_file_size_bytes, allowed_exts_json, overwrite,
                    share_back_enabled, created_at, created_by
                ) VALUES (?, '/', '/incoming', 'Test intake', NULL, NULL, 0, ?, NULL, 0, 0, ?, 'test')
                """,
                (self.request_id, 200 * 1024 * 1024 * 1024, 1_700_000_000),
            )
        self.client = server.app.test_client()

    def tearDown(self):
        with server._upload_requests_conn() as conn:
            conn.execute("DELETE FROM upload_requests WHERE request_id = ?", (self.request_id,))
        incoming = os.path.join(server.FILEBROWSER_ROOT, "incoming")
        for name in os.listdir(incoming):
            os.remove(os.path.join(incoming, name))

    def create_session(self, filename, payload, checksum_algorithm=None):
        response = self.client.post(
            f"/api/upload-request/{self.request_id}/session",
            json={
                "filename": filename,
                "size": len(payload),
                "last_modified": 1_700_000_000_000,
                "content_type": "application/octet-stream",
                "checksum_algorithm": checksum_algorithm,
            },
        )
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return response.get_json()

    def set_max_files(self, value):
        with server._upload_requests_conn() as conn:
            conn.execute(
                "UPDATE upload_requests SET max_files = ? WHERE request_id = ?",
                (value, self.request_id),
            )

    def set_overwrite(self, value):
        with server._upload_requests_conn() as conn:
            conn.execute(
                "UPDATE upload_requests SET overwrite = ? WHERE request_id = ?",
                (1 if value else 0, self.request_id),
            )

    def upload_all_chunks(self, created, payload):
        session_id = created["session_id"]
        headers = {"X-Upload-Token": created["upload_token"]}
        chunk_size = created["status"]["chunk_size"]
        for index in range(created["status"]["chunk_count"]):
            start = index * chunk_size
            response = self.client.put(
                f"/api/upload-request/{self.request_id}/session/{session_id}/chunk/{index}",
                data=payload[start:start + chunk_size],
                headers=headers,
                content_type="application/octet-stream",
            )
            self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return headers

    def test_200_gib_uses_6400_resumable_chunks(self):
        size = 200 * 1024 * 1024 * 1024
        with mock.patch.object(server, "UPLOAD_SESSION_CHUNK_SIZE_BYTES", 16 * 1024 * 1024):
            chunk_size = server._choose_upload_session_chunk_size(size)

        self.assertEqual(chunk_size, 32 * 1024 * 1024)
        self.assertEqual((size + chunk_size - 1) // chunk_size, 6400)

    def test_chunks_resume_out_of_order_and_commit_idempotently(self):
        payload = (b"droppr-resume-proof-" * 300_000) + b"done"
        created = self.create_session("proof.bin", payload)
        session_id = created["session_id"]
        upload_token = created["upload_token"]
        status = created["status"]
        self.assertEqual(status["chunk_count"], 2)
        chunk_size = status["chunk_size"]
        headers = {"X-Upload-Token": upload_token}

        second = self.client.put(
            f"/api/upload-request/{self.request_id}/session/{session_id}/chunk/1",
            data=payload[chunk_size:],
            headers=headers,
            content_type="application/octet-stream",
        )
        self.assertEqual(second.status_code, 200, second.get_data(as_text=True))

        resumed = self.client.get(
            f"/api/upload-request/{self.request_id}/session/{session_id}",
            headers=headers,
        )
        self.assertEqual(resumed.status_code, 200)
        self.assertEqual(resumed.get_json()["status"]["received"], [1])

        first = self.client.put(
            f"/api/upload-request/{self.request_id}/session/{session_id}/chunk/0",
            data=payload[:chunk_size],
            headers=headers,
            content_type="application/octet-stream",
        )
        self.assertEqual(first.status_code, 200, first.get_data(as_text=True))

        commit_url = f"/api/upload-request/{self.request_id}/session/{session_id}/commit"
        committed = self.client.post(commit_url, headers=headers)
        self.assertEqual(committed.status_code, 200, committed.get_data(as_text=True))
        self.assertTrue(committed.get_json()["status"]["committed"])

        final_path = os.path.join(server.FILEBROWSER_ROOT, "incoming", "proof.bin")
        with open(final_path, "rb") as uploaded:
            self.assertEqual(uploaded.read(), payload)

        committed_again = self.client.post(commit_url, headers=headers)
        self.assertEqual(committed_again.status_code, 200)
        with server._upload_requests_conn() as conn:
            audit_count = conn.execute(
                "SELECT COUNT(1) AS c FROM upload_files WHERE upload_session_id = ?",
                (session_id,),
            ).fetchone()["c"]
        self.assertEqual(audit_count, 1)

    def test_wrong_resume_token_is_rejected(self):
        created = self.create_session("token-check.bin", b"hello")
        response = self.client.get(
            f"/api/upload-request/{self.request_id}/session/{created['session_id']}",
            headers={"X-Upload-Token": "wrong"},
        )
        self.assertEqual(response.status_code, 403)
        canceled = self.client.delete(
            f"/api/upload-request/{self.request_id}/session/{created['session_id']}",
            headers={"X-Upload-Token": created["upload_token"]},
        )
        self.assertEqual(canceled.status_code, 200)

    def test_sha256_verified_chunk_rejects_mismatch_before_checkpoint(self):
        payload = b"verify-this-upload-chunk"
        created = self.create_session("verified.bin", payload, checksum_algorithm="sha256")
        session_id = created["session_id"]
        missing = self.client.put(
            f"/api/upload-request/{self.request_id}/session/{session_id}/chunk/0",
            data=payload,
            headers={"X-Upload-Token": created["upload_token"]},
            content_type="application/octet-stream",
        )
        self.assertEqual(missing.status_code, 400, missing.get_data(as_text=True))
        headers = {
            "X-Upload-Token": created["upload_token"],
            "X-Chunk-SHA256": "0" * 64,
        }
        rejected = self.client.put(
            f"/api/upload-request/{self.request_id}/session/{session_id}/chunk/0",
            data=payload,
            headers=headers,
            content_type="application/octet-stream",
        )
        self.assertEqual(rejected.status_code, 422, rejected.get_data(as_text=True))
        self.assertEqual(server._upload_session_received(server._load_upload_session(session_id)), set())

        headers["X-Chunk-SHA256"] = hashlib.sha256(payload).hexdigest()
        accepted = self.client.put(
            f"/api/upload-request/{self.request_id}/session/{session_id}/chunk/0",
            data=payload,
            headers=headers,
            content_type="application/octet-stream",
        )
        self.assertEqual(accepted.status_code, 200, accepted.get_data(as_text=True))
        self.assertTrue(accepted.get_json()["verified"])
        self.assertEqual(accepted.get_json()["checksum_sha256"], headers["X-Chunk-SHA256"])

        committed = self.client.post(
            f"/api/upload-request/{self.request_id}/session/{session_id}/commit",
            headers={"X-Upload-Token": created["upload_token"]},
        )
        self.assertEqual(committed.status_code, 200, committed.get_data(as_text=True))
        with open(os.path.join(server.FILEBROWSER_ROOT, "incoming", "verified.bin"), "rb") as uploaded:
            self.assertEqual(uploaded.read(), payload)

    def test_unknown_checksum_algorithm_is_rejected(self):
        response = self.client.post(
            f"/api/upload-request/{self.request_id}/session",
            json={"filename": "unknown.bin", "size": 5, "checksum_algorithm": "md5"},
        )
        self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
        self.assertIn("Unsupported chunk checksum algorithm", response.get_json()["error"])

    def test_admin_observes_progress_and_cancels_active_session(self):
        payload = (b"admin-progress-" * 400_000) + b"tail"
        created = self.create_session("long-transfer.bin", payload, checksum_algorithm="sha256")
        session_id = created["session_id"]
        chunk_size = created["status"]["chunk_size"]
        first_chunk = payload[:chunk_size]
        uploaded = self.client.put(
            f"/api/upload-request/{self.request_id}/session/{session_id}/chunk/0",
            data=first_chunk,
            headers={
                "X-Upload-Token": created["upload_token"],
                "X-Chunk-SHA256": hashlib.sha256(first_chunk).hexdigest(),
            },
            content_type="application/octet-stream",
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.get_data(as_text=True))

        admin_headers = {"X-Auth": "admin-test-token"}
        with mock.patch.object(server, "_validate_filebrowser_admin", return_value=None):
            listed = self.client.get("/api/upload-requests", headers=admin_headers)
            detailed = self.client.get(
                f"/api/upload-request/{self.request_id}/detail",
                headers=admin_headers,
            )

        self.assertEqual(listed.status_code, 200, listed.get_data(as_text=True))
        summary = listed.get_json()["requests"][0]
        self.assertEqual(summary["active_session_count"], 1)
        self.assertEqual(summary["active_received_bytes"], len(first_chunk))
        self.assertEqual(summary["active_total_bytes"], len(payload))
        self.assertEqual(summary["active_verified_count"], 1)

        self.assertEqual(detailed.status_code, 200, detailed.get_data(as_text=True))
        detail = detailed.get_json()["request"]
        self.assertEqual(detail["active_session_count"], 1)
        self.assertEqual(len(detail["sessions"]), 1)
        self.assertEqual(detail["sessions"][0]["session_id"], session_id)
        self.assertEqual(detail["sessions"][0]["received_bytes"], len(first_chunk))
        self.assertTrue(detail["sessions"][0]["verified"])

        unauthorized = self.client.delete(
            f"/api/upload-request/{self.request_id}/session/{session_id}/admin"
        )
        self.assertEqual(unauthorized.status_code, 401)
        with mock.patch.object(server, "_validate_filebrowser_admin", return_value=None):
            canceled = self.client.delete(
                f"/api/upload-request/{self.request_id}/session/{session_id}/admin",
                headers=admin_headers,
            )
        self.assertEqual(canceled.status_code, 200, canceled.get_data(as_text=True))
        self.assertEqual(canceled.get_json()["canceled"]["received_bytes"], len(first_chunk))
        self.assertIsNone(server._load_upload_session(session_id))

    def test_cancel_removes_partial_upload(self):
        payload = b"cancel-me"
        created = self.create_session("cancel.bin", payload)
        session_id = created["session_id"]
        headers = {"X-Upload-Token": created["upload_token"]}
        response = self.client.delete(
            f"/api/upload-request/{self.request_id}/session/{session_id}",
            headers=headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(server._load_upload_session(session_id))

    def test_abandoned_session_can_be_replaced_but_file_limit_is_atomic_at_commit(self):
        self.set_max_files(1)
        abandoned_payload = b"browser-storage-was-lost"
        replacement_payload = b"replacement-finishes"
        abandoned = self.create_session("first.bin", abandoned_payload)
        replacement = self.create_session("replacement.bin", replacement_payload)

        replacement_headers = self.upload_all_chunks(replacement, replacement_payload)
        replacement_commit = self.client.post(
            f"/api/upload-request/{self.request_id}/session/{replacement['session_id']}/commit",
            headers=replacement_headers,
        )
        self.assertEqual(replacement_commit.status_code, 200, replacement_commit.get_data(as_text=True))

        abandoned_headers = self.upload_all_chunks(abandoned, abandoned_payload)
        abandoned_commit = self.client.post(
            f"/api/upload-request/{self.request_id}/session/{abandoned['session_id']}/commit",
            headers=abandoned_headers,
        )
        self.assertEqual(abandoned_commit.status_code, 409, abandoned_commit.get_data(as_text=True))
        self.assertIn("File limit reached", abandoned_commit.get_json()["error"])

        canceled = self.client.delete(
            f"/api/upload-request/{self.request_id}/session/{abandoned['session_id']}",
            headers=abandoned_headers,
        )
        self.assertEqual(canceled.status_code, 200)
        with server._upload_requests_conn() as conn:
            audit_count = conn.execute(
                "SELECT COUNT(1) AS c FROM upload_files WHERE request_id = ?",
                (self.request_id,),
            ).fetchone()["c"]
        self.assertEqual(audit_count, 1)

    def test_active_session_safety_cap_is_separate_from_file_limit(self):
        self.set_max_files(1)
        created = []
        with mock.patch.object(server, "UPLOAD_SESSION_MAX_ACTIVE_PER_REQUEST", 2):
            created.append(self.create_session("one.bin", b"one"))
            created.append(self.create_session("two.bin", b"two"))
            blocked = self.client.post(
                f"/api/upload-request/{self.request_id}/session",
                json={"filename": "three.bin", "size": 5},
            )
        self.assertEqual(blocked.status_code, 409, blocked.get_data(as_text=True))
        self.assertIn("Too many active upload sessions", blocked.get_json()["error"])

        for session in created:
            response = self.client.delete(
                f"/api/upload-request/{self.request_id}/session/{session['session_id']}",
                headers={"X-Upload-Token": session["upload_token"]},
            )
            self.assertEqual(response.status_code, 200)

    def test_commit_recovery_does_not_accept_an_unmoved_same_size_file(self):
        self.set_overwrite(True)
        payload = b"N" * 4096
        old_payload = b"O" * len(payload)
        final_path = os.path.join(server.FILEBROWSER_ROOT, "incoming", "same-size.bin")
        with open(final_path, "wb") as existing:
            existing.write(old_payload)

        created = self.create_session("same-size.bin", payload)
        headers = self.upload_all_chunks(created, payload)
        session_id = created["session_id"]
        session = server._load_upload_session(session_id)
        self.assertGreater(int(session["temp_device"] or 0), 0)
        self.assertGreater(int(session["temp_inode"] or 0), 0)

        # Simulate a crash after the durable state transition but before
        # os.replace(). The old target has the same size and must not be
        # mistaken for the uploaded inode.
        with server._upload_requests_conn() as conn:
            conn.execute(
                "UPDATE upload_sessions SET status = 'committing' WHERE session_id = ?",
                (session_id,),
            )

        committed = self.client.post(
            f"/api/upload-request/{self.request_id}/session/{session_id}/commit",
            headers=headers,
        )
        self.assertEqual(committed.status_code, 200, committed.get_data(as_text=True))
        with open(final_path, "rb") as uploaded:
            self.assertEqual(uploaded.read(), payload)

    def test_commit_recovers_after_the_uploaded_inode_was_moved(self):
        self.set_overwrite(True)
        payload = b"recover-the-real-uploaded-inode"
        created = self.create_session("moved-before-crash.bin", payload)
        headers = self.upload_all_chunks(created, payload)
        session_id = created["session_id"]
        session = server._load_upload_session(session_id)
        info = server._get_upload_request(self.request_id)
        temp_path = server._upload_session_temp_path(info, session_id)
        final_path = server._upload_session_final_path(info, session["stored_name"])

        # Simulate the opposite side of the crash window: the atomic move
        # happened, but the audit/status transaction did not.
        with server._upload_requests_conn() as conn:
            conn.execute(
                "UPDATE upload_sessions SET status = 'committing' WHERE session_id = ?",
                (session_id,),
            )
        os.replace(temp_path, final_path)

        committed = self.client.post(
            f"/api/upload-request/{self.request_id}/session/{session_id}/commit",
            headers=headers,
        )
        self.assertEqual(committed.status_code, 200, committed.get_data(as_text=True))
        self.assertTrue(committed.get_json()["status"]["committed"])
        with open(final_path, "rb") as uploaded:
            self.assertEqual(uploaded.read(), payload)
        with server._upload_requests_conn() as conn:
            audit_count = conn.execute(
                "SELECT COUNT(1) AS c FROM upload_files WHERE upload_session_id = ?",
                (session_id,),
            ).fetchone()["c"]
        self.assertEqual(audit_count, 1)


if __name__ == "__main__":
    unittest.main()
