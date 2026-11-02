#!/usr/bin/env python3
"""Exercise actual HTTP handlers and PDF conversion without opening a port."""
import io
import json
import os
import re
from pathlib import Path
import shutil
import struct
import tempfile
import time
from types import SimpleNamespace
import zlib
from datetime import datetime

TEST_DATA = tempfile.TemporaryDirectory(prefix="local-export-verify-")
os.environ["LOCAL_EXPORT_DATA_DIR"] = TEST_DATA.name
import server
import pdf_layout


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


def request(method, path, data=None, origin=None, content_type="application/json"):
    body = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else b""
    headers = f"Host: 127.0.0.1:8765\r\nContent-Length: {len(body)}\r\nContent-Type: {content_type}\r\n"
    if origin:
        headers += f"Origin: {origin}\r\n"
    sock = MemorySocket(f"{method} {path} HTTP/1.0\r\n{headers}\r\n".encode() + body)
    QuietHandler(sock, ("127.0.0.1", 12345), SimpleNamespace(server_port=8765))
    head, content = sock.output.getvalue().split(b"\r\n\r\n", 1)
    code = int(head.split(b" ")[1])
    return code, content


def wait_for(job_id):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        code, body = request("GET", f"/api/pdf/v1/{job_id}")
        assert code == 200
        result = json.loads(body)
        if result["status"] in ("done", "failed"):
            return result
        time.sleep(.2)
    raise AssertionError("PDF job timed out")


def main():
    assert request("GET", "/health")[0] == 200
    assert request("POST", "/api/pdf/v1", {"markdown": "test"}, "https://example.org")[0] == 403
    assert request("POST", "/api/pdf/v1", {"markdown": "test"}, "http://127.0.0.1:8765")[0] == 403
    assert request("OPTIONS", "/api/pdf/v1", origin="chrome-extension://test")[0] == 200
    assert request("POST", "/api/pdf/v1", {"payload": {"exportInfo": {}}})[0] == 400
    assert request("GET", "/api/pdf/v1/" + "a" * 32)[0] == 404
    assert request("POST", "/api/account", {"cmd": "update", "payload": {"name": "本地测试", "email": "test@localhost"}})[0] == 200
    assert json.loads(request("GET", "/api/account")[1])["name"] == "本地测试"
    assert json.loads(request("GET", "/api/account")[1])["local"] is True
    timestamp = datetime(2026, 7, 21, 15, 8).timestamp() * 1000
    for date_format, expected in (("MDY", "07/21/2026"), ("DMY", "21/07/2026"), ("YMD", "2026/07/21")):
        result = pdf_layout.metadata({"exportInfo": {"timestamps": {"createdRaw": timestamp}}, "options": {"dateSettings": {"includeDateType": "create", "dateFormat": date_format, "timeFormat": "none"}}})
        assert expected in result and not re.search(r"\d:\d", result), result
    assert "03:08 PM" in pdf_layout.metadata({"exportInfo": {"timestamps": {"createdRaw": timestamp}}, "options": {"dateSettings": {"includeDateType": "create", "dateFormat": "MDY", "timeFormat": "12hour"}}})
    assert request("POST", "/api/settings", {"settings": {"commonOptions": {"includeConvoLink": True}, "exportType": "md"}})[0] == 200
    assert json.loads(request("GET", "/api/settings")[1])["settings"]["exportType"] == "md"
    assert request("POST", "/api/settings", {"settings": {"auth": "must not store"}})[0] == 400
    assert request("POST", "/api/config/v3", {"cmd": "save", "payload": {"selectors": {"elemMsgs_chat": "article"}}})[0] == 200
    assert json.loads(request("GET", "/api/config/v3")[1])["selectors"]["elemMsgs_chat"] == "article"
    assert request("POST", "/api/feedback/v1", {"message": "本地反馈", "storage": {"token": "omit"}})[0] == 200
    feedback = json.loads(request("GET", "/api/feedback/v1")[1])["items"]
    assert feedback[0]["data"] == {"message": "本地反馈"}
    # A real PNG fixture, generated using only the standard library.
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))
    image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 32, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress((b"\0" + b"\x10\xa0\x80" * 64) * 32)) + chunk(b"IEND", b"")
    multipart = b'--localtest\r\nContent-Disposition: form-data; name="file"; filename="example.png"\r\nContent-Type: image/png\r\n\r\n' + image + b"\r\n--localtest--\r\n"
    code, body = request("POST", "/api/file/u/v1", multipart, content_type="multipart/form-data; boundary=localtest")
    assert code == 200, body
    image_url = json.loads(body)["url"]
    assert request("GET", image_url.removeprefix("http://127.0.0.1:8765"))[1] == image
    assert request("GET", "/api/file/../../server.py")[0] == 404
    payload = json.loads((server.ROOT / "demo.json").read_text())
    code, body = request("POST", "/api/pdf/v1", payload, "chrome-extension://test")
    assert code == 200
    job_id = json.loads(body)["jobId"]
    result = wait_for(job_id)
    assert result["status"] == "done", result
    assert result["downloadUrl"].startswith("http://127.0.0.1:8765/")
    code, pdf = request("GET", f"/api/pdf/v1/{job_id}/download")
    assert code == 200 and pdf.startswith(b"%PDF-"), (code, pdf[:100])
    output = server.ROOT.parent / "output/pdf/local-export-demo.pdf"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(pdf)
    assert list(server.JOBS[job_id]["directory"].iterdir()) == [server.JOBS[job_id]["directory"] / "document.pdf"]
    assert json.loads(request("GET", "/api/usage")[1])["counts"]["pdf"] == 1
    assert request("POST", "/api/usage", {"cmd": "record", "payload": {"format": "md"}})[0] == 200
    assert json.loads(request("GET", "/api/usage")[1])["counts"]["md"] == 1
    # Completed jobs and profile settings survive an empty process job cache.
    server.JOBS.pop(job_id)
    assert json.loads(request("GET", f"/api/pdf/v1/{job_id}")[1])["status"] == "done"
    enriched = {"messages": [
        {"role": "Prompt", "heading": "用户", "markdown": "中文图片：\n\n![测试](" + image_url + ")"},
        {"role": "Response", "heading": "助手", "markdown": r"公式 $x^2+y^2=z^2$", "model": "local-test"},
        {"role": "Prompt", "heading": "用户", "markdown": "第二页问题"}],
        "title": "本地完整排版验证", "exportInfo": {"user": {"name": "本地测试", "email": "test@localhost"}},
        "options": {"format": "a5", "landscape": True, "margin": "narrow", "darkMode": True, "lang": "zh-CN",
                    "fontSize": 110, "fontFamily": "serif", "removePageNumber": True,
                    "toc": True, "removeBrand": True, "pageBreakPerPrompt": True,
                    "tocStyle": {"user": {"prefix": "Q: ", "fontColor": "#10b981", "bgColor": "#172b25"}, "assistant": {"prefix": "A: ", "fontColor": "#a5b4fc", "bgColor": "#24273e"}},
                    "userInfo": {"includeUserName": True}, "includeModelName": True}}
    code, body = request("POST", "/api/pdf/v1", {"cmd": "create", "payload": enriched})
    assert code == 200
    enriched_id = json.loads(body)["jobId"]
    enriched_result = wait_for(enriched_id)
    assert enriched_result["status"] == "done", enriched_result
    extra_pdf = request("GET", f"/api/pdf/v1/{enriched_id}/download")[1]
    assert re.search(rb"/Subtype\s*/Image", extra_pdf), "Uploaded image was not embedded"
    (output.parent / "local-layout-demo.pdf").write_bytes(extra_pdf)
    # No image URL or local path survives into the PDF engine's input.
    node = {"t": "Image", "c": [["", [], []], [], ["/etc/passwd", ""]]}
    assert server.clean_ast(node)["t"] == "Str"
    code, body = request("POST", "/api/pdf/v1", {"payload": {"localMarkdown": r"$\input{/etc/passwd}$"}})
    assert code == 200
    failed = wait_for(json.loads(body)["jobId"])
    assert failed["status"] == "failed" and "unsupported TeX" in failed["errmsg"]
    print(f"PASS: profile/config/preferences persistence, local feedback, usage, multipart PNG upload, safe image retrieval, persistent PDF jobs, Chinese/math/code/table/image PDF, A5 landscape/dark/serif/TOC/page breaks, origin and path rejection. PDFs: {len(pdf)} and {len(extra_pdf)} bytes")


if __name__ == "__main__":
    try:
        main()
    finally:
        server.POOL.shutdown(wait=True)
        for job in server.JOBS.values():
            shutil.rmtree(job["directory"], ignore_errors=True)
        TEST_DATA.cleanup()
