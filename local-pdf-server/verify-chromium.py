#!/usr/bin/env python3
"""Static snapshot/API tests; mock only browser startup/rendering boundary."""
import io
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch

TEST_DATA = tempfile.TemporaryDirectory(prefix="web-pdf-api-test-")
os.environ["LOCAL_EXPORT_DATA_DIR"] = TEST_DATA.name
import chromium_renderer
import server


class MemorySocket:
    def __init__(self, data):
        self.input = io.BytesIO(data)
        self.output = io.BytesIO()

    def makefile(self, *args):
        return self.input

    def sendall(self, data):
        self.output.write(data)


class QuietHandler(server.Handler):
    def log_message(self, *args):
        pass


def request(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else b""
    headers = f"Host: 127.0.0.1:8765\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n"
    sock = MemorySocket(f"{method} {path} HTTP/1.0\r\n".encode() + headers.encode() + data)
    QuietHandler(sock, ("127.0.0.1", 1), SimpleNamespace(server_port=8765))
    head, body = sock.output.getvalue().split(b"\r\n\r\n", 1)
    return int(head.split(b" ")[1]), body


def wait(job_id):
    for _ in range(200):
        result = json.loads(request("GET", f"/api/pdf/v1/{job_id}")[1])
        if result["status"] in ("done", "failed"):
            return result
        time.sleep(.02)
    raise AssertionError("Mock browser job did not finish")


def main():
    payload = {"webDocument": {"html": '<!doctype html><html class="dark frozen-root"><head><style>.frozen{color:rgb(12,34,56)}</style></head><body class="frozen-body"><script>alert(1)</script><p class="frozen" onclick="alert(2)">网页原样公式 <math><mi>x</mi></math></p></body></html>', "css": ".font{font-family:serif}", "width": 760, "theme": "dark"}, "options": {"format": "a4"}}
    sanitized = chromium_renderer.prepare_document(payload)["html"]
    assert "<script" not in sanitized and "onclick" not in sanitized
    assert "script-src &#x27;none&#x27;" in sanitized
    assert "rgb(12,34,56)" in sanitized and "frozen-root" in sanitized and "frozen-body" in sanitized
    for document in ({"html": '<img src="file:///etc/passwd">'}, {"html": '<img src="https://example.org/image.png">'}, {"html": "<p>x</p>", "css": '@import "https://example.org/style.css";'}, {"html": "<p>x</p>", "css": "a{background:url(file:///etc/passwd)}"}, {"html": "<p>x</p>", "width": float("inf")}):
        assert request("POST", "/api/pdf/v1", {"webDocument": document})[0] == 400
    assert request("POST", "/api/pdf/v1", {"engine": "chromium", "markdown": "No frozen page"})[0] == 400
    assert request("POST", "/api/pdf/v1", {"engine": "other", "markdown": "No"})[0] == 400
    assert server.selected_engine({"markdown": "old API"}) == "pandoc"

    def success(payload, directory, prepared=None):
        assert prepared and "网页原样公式" in prepared["html"]
        (directory / "document.pdf").write_bytes(b"%PDF-1.7\nmock browser boundary")
        return {"engine": "chromium", "sandboxEnabled": True, "networkEnabled": False}

    with patch.object(chromium_renderer, "render", side_effect=success), patch.object(server, "command", side_effect=AssertionError("Must not call Pandoc")):
        code, body = request("POST", "/api/pdf/v1", payload)
        assert code == 200, body
        created = json.loads(body)
        assert created["engine"] == "chromium" and created["htmlUrl"].endswith("/html")
        result = wait(created["jobId"])
        assert result["status"] == "done", result
        assert request("GET", result["htmlUrl"].removeprefix("http://127.0.0.1:8765"))[0] == 200
        assert request("GET", result["downloadUrl"].removeprefix("http://127.0.0.1:8765"))[1].startswith(b"%PDF-")
    with patch.object(chromium_renderer, "render", side_effect=RuntimeError("Chromium startup denied by test sandbox")), patch.object(server, "command", side_effect=AssertionError("No silent fallback")):
        code, body = request("POST", "/api/pdf/v1", payload)
        job_id = json.loads(body)["jobId"]
        result = wait(job_id)
        assert result["status"] == "failed" and result["engine"] == "chromium"
        assert "startup denied" in result["errmsg"]
        snapshot = request("GET", f"/api/pdf/v1/{job_id}/html")
        assert snapshot[0] == 200 and b"onclick" not in snapshot[1]
        assert request("GET", f"/api/pdf/v1/{job_id}/download")[0] == 409
        server.JOBS.pop(job_id)
        assert json.loads(request("GET", f"/api/pdf/v1/{job_id}")[1])["engine"] == "chromium"
    with patch.object(server.shutil, "which", return_value=None), patch.object(chromium_renderer, "availability", return_value={"available": True, "startupVerified": False}):
        health = json.loads(request("GET", "/health")[1])
        assert health["ok"] and not health["engines"]["pandoc"]["available"]
        assert health["engines"]["chromium"]["lastRender"]["ok"] is False
    print("PASS: frozen HTML/CSS preservation, scripts/events stripped, external/file resource rejection, engine validation/defaults, Chromium-only API without Pandoc, persistent engine/error, HTML recovery after startup failure, health readiness distinction")


if __name__ == "__main__":
    try:
        main()
    finally:
        server.POOL.shutdown(wait=True)
        TEST_DATA.cleanup()
