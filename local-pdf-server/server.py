#!/usr/bin/env python3
"""Loopback-only Pandoc/XeLaTeX PDF jobs. Python standard library only."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import uuid
import signal
from email.parser import BytesParser
from email.policy import default as email_policy
from urllib.parse import quote

import local_images
import local_state
import pdf_layout
import chromium_renderer

ROOT = Path(__file__).resolve().parent
JOBS = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=2)
MAX_BODY = 64 * 1024 * 1024


def command(args, cwd, stdin=None):
    env = dict(os.environ, openin_any="p", openout_any="p")
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, cwd=cwd, env=env,
                               start_new_session=True)
    try:
        stdout, stderr = process.communicate(stdin, timeout=150)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise RuntimeError("PDF conversion timed out (150 seconds)")
    if process.returncode:
        raise RuntimeError(stderr[-5000:] or "Conversion failed")
    return stdout


def clean_ast(value, directory=None):
    """Do not let Pandoc load arbitrary image files/URLs or pass raw markup."""
    if isinstance(value, list):
        return [clean_ast(item, directory) for item in value]
    if not isinstance(value, dict):
        return value
    kind = value.get("t")
    if kind in ("RawBlock", "RawInline"):
        return {"t": "Str", "c": ""} if kind == "RawInline" else {"t": "Null"}
    if kind == "Image":
        target = local_images.resolve_for_job(value["c"][2][0], directory)
        if target:
            value["c"][2][0] = target
            return value
        return {"t": "Str", "c": "[图片未嵌入：需先由浏览器上传至本机服务]"}
    if kind == "Math":
        math = value["c"][1]
        if "^^" in math or re.search(r"\\(?:input|include|includegraphics|write|read|openin|openout|catcode|csname|def|gdef|edef|xdef|let|futurelet|special|usepackage|documentclass|newcommand|renewcommand|loop|directlua|scantokens|every\w*|expandafter|noexpand|endinput|enddocument|immediate|shipout|pdf\w*|XeTeX\w*)\b", math):
            raise ValueError("Formula contains unsupported TeX commands")
    return {key: clean_ast(item, directory) for key, item in value.items()}


def markdown_from_payload(payload):
    return pdf_layout.compose(payload)


def selected_engine(payload):
    if not isinstance(payload, dict):
        raise ValueError("PDF payload must be an object")
    engine = payload.get("engine") or ("chromium" if "webDocument" in payload else "pandoc")
    if engine not in ("chromium", "pandoc"):
        raise ValueError("PDF engine must be chromium or pandoc")
    return engine


def engine_health():
    dependencies = {name: shutil.which(name) for name in ("pandoc", "xelatex")}
    chromium = chromium_renderer.availability()
    previous = local_state.get("chromium:last-render")
    if previous:
        chromium["lastRender"] = previous
        chromium["startupVerified"] = previous.get("ok", False)
    return {"pandoc": {"available": all(dependencies.values()), "dependencies": dependencies},
            "chromium": chromium}


def save_job(job_id):
    job = JOBS[job_id]
    local_state.put("job:" + job_id, {key: value for key, value in job.items() if key != "directory"})


def find_job(job_id):
    with LOCK:
        if job_id in JOBS:
            return dict(JOBS[job_id])
        stored = local_state.get("job:" + job_id)
        if not stored:
            return None
        stored["directory"] = local_state.data_dir() / "jobs" / job_id
        if stored["status"] in ("queued", "processing"):
            stored.update(status="failed", errmsg="本地服务在任务完成前停止，请重试")
        JOBS[job_id] = stored
        return dict(stored)


def generate(job_id, payload, prepared=None):
    with LOCK:
        job = JOBS[job_id]
        job["status"] = "processing"
        save_job(job_id)
    try:
        directory = job["directory"]
        engine = selected_engine(payload)
        if engine == "chromium":
            prepared = prepared or chromium_renderer.prepare_document(payload)
            # Retain a safe static snapshot even if the browser cannot launch.
            (directory / "original.html").write_text(prepared["html"], encoding="utf-8")
            result = chromium_renderer.render(payload, directory, prepared)
            local_state.put("chromium:last-render", {"ok": True, "at": time.time(), "result": result})
        else:
            markdown = markdown_from_payload(payload)
            if not markdown.strip():
                raise ValueError("No chat content selected")
            ast = json.loads(command(["pandoc", "--from=markdown+tex_math_dollars+tex_math_single_backslash-raw_tex-raw_html", "--to=json"], directory, markdown))
            ast = pdf_layout.apply_pagebreaks(clean_ast(ast, directory), payload)
            (directory / "document.json").write_text(json.dumps(ast), encoding="utf-8")
            options = dict(payload.get("options") or {})
            options["_customToc"] = bool(payload.get("messages") and isinstance(options.get("tocStyle"), dict))
            args = pdf_layout.arguments(options, directory, ROOT / "header.tex")
            command(args, directory)
        with LOCK:
            job.update(status="done", engine=engine, filename=pdf_layout.safe_filename(payload), fileSizeMB=round((directory / "document.pdf").stat().st_size / 1048576, 3))
            save_job(job_id)
        local_state.usage({"cmd": "report", "payload": {"format": "pdf"}})
    except Exception as error:
        if job.get("engine") == "chromium":
            local_state.put("chromium:last-render", {"ok": False, "at": time.time(), "error": str(error)})
        with LOCK:
            job.update(status="failed", errmsg=str(error))
            save_job(job_id)
    finally:
        # Keep a self-contained, script-free HTML alternative for webpage jobs.
        for item in job["directory"].iterdir():
            if item.name not in ("document.pdf", "original.html"):
                item.unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    def allowed(self):
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        return host == f"127.0.0.1:{self.server.server_port}" and (
            not origin or origin.startswith("chrome-extension://"))

    def headers_for(self, code, mime):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def reply(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.headers_for(code, "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self.allowed():
            return self.reply({"errcode": -1, "errmsg": "Origin/Host rejected"}, 403)
        self.reply({"errcode": 0})

    def do_POST(self):
        if not self.allowed():
            return self.reply({"errcode": -1, "errmsg": "Origin/Host rejected"}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                return self.reply({"errcode": -1, "errmsg": "Body must be 1 byte to 64 MiB"}, 413)
            data = self.rfile.read(length)
            if len(data) != length:
                raise ValueError("Incomplete request body")
            if self.path == "/api/file/u/v1":
                return self.upload(data)
            request = json.loads(data)
            if not isinstance(request, dict):
                raise ValueError("JSON body must be an object")
            routes = {"/api/account": local_state.account, "/api/usage": local_state.usage,
                      "/api/config/v3": local_state.config, "/api/feedback/v1": local_state.feedback,
                      "/api/settings": local_state.settings}
            if self.path in routes:
                return self.reply(routes[self.path](request))
            if self.path != "/api/pdf/v1":
                return self.reply({"errcode": -1, "errmsg": "Not found"}, 404)
            if request.get("cmd", "create") != "create":
                raise ValueError("Unsupported command")
            payload = request.get("payload", request)
            engine = selected_engine(payload)
            prepared = chromium_renderer.prepare_document(payload) if engine == "chromium" else None
            if engine == "pandoc":
                markdown_from_payload(payload)
            job_id = uuid.uuid4().hex
            with LOCK:
                # Retain at most 50 jobs in the active queue. Completed PDF data
                # remains local for download across service restarts.
                for key, job in list(JOBS.items()):
                    if job["status"] in ("done", "failed") and len(JOBS) >= 50:
                        del JOBS[key]
                if len(JOBS) >= 50:
                    return self.reply({"errcode": -1, "errmsg": "Queue full"}, 429)
                directory = local_state.data_dir() / "jobs" / job_id
                directory.mkdir(parents=True)
                JOBS[job_id] = {"status": "queued", "engine": engine, "directory": directory, "created": time.time()}
                if prepared:
                    (directory / "original.html").write_text(prepared["html"], encoding="utf-8")
                save_job(job_id)
            POOL.submit(generate, job_id, payload, prepared)
            result = {"errcode": 0, "jobId": job_id, "status": "queued", "engine": engine}
            if prepared:
                result["htmlUrl"] = f"http://127.0.0.1:{self.server.server_port}/api/pdf/v1/{job_id}/html"
            self.reply(result)
        except (ValueError, TypeError, AttributeError) as error:
            self.reply({"errcode": -1, "errmsg": str(error)}, 400)
        except (OSError, subprocess.SubprocessError) as error:
            self.reply({"errcode": -2, "errmsg": str(error)}, 500)

    def upload(self, data):
        content_type = self.headers.get("Content-Type", "")
        if not content_type.startswith("multipart/form-data;"):
            raise ValueError("Expected multipart/form-data")
        message = BytesParser(policy=email_policy).parsebytes(("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + data)
        if not message.is_multipart():
            raise ValueError("Malformed multipart upload")
        for part in message.iter_parts():
            if part.get_param("name", header="content-disposition") == "file":
                name, mime = local_images.store(part.get_payload(decode=True))
                return self.reply({"errcode": 0, "url": f"http://127.0.0.1:{self.server.server_port}/api/file/{name}", "mime": mime})
        raise ValueError("No file part supplied")

    def do_GET(self):
        if not self.allowed():
            return self.reply({"errcode": -1, "errmsg": "Origin/Host rejected"}, 403)
        path = urlsplit(self.path).path
        if path == "/health":
            engines = engine_health()
            return self.reply({"ok": any(item["available"] for item in engines.values()), "engine": "chromium / pandoc + xelatex", "engines": engines, "dependencies": engines["pandoc"]["dependencies"], "supportsWebDocument": True, "remoteImageFetch": False, "local": True, "version": 3})
        routes = {"/api/account": local_state.account, "/api/usage": local_state.usage,
                  "/api/config/v3": local_state.config, "/api/feedback/v1": local_state.feedback_list,
                  "/api/settings": local_state.settings}
        if path in routes:
            return self.reply(routes[path]())
        if path.startswith("/api/file/"):
            image = local_images.owned_path(path.removeprefix("/api/file/"))
            if image is None:
                return self.reply({"errcode": -1, "errmsg": "Unknown image"}, 404)
            return self.binary(image.read_bytes(), "image/png" if image.suffix == ".png" else "image/jpeg")
        match = re.fullmatch(r"/api/pdf/v1/([a-f0-9]{32})(/(?:download|html))?", path)
        if not match:
            return self.reply({"errcode": -1, "errmsg": "Not found"}, 404)
        job_id, action = match.groups()
        job = find_job(job_id)
        if not job:
            return self.reply({"errcode": -1, "errmsg": "Unknown job"}, 404)
        if action == "/html":
            snapshot = job["directory"] / "original.html"
            if not snapshot.is_file():
                return self.reply({"errcode": -1, "errmsg": "No webpage snapshot exists for this job"}, 404)
            return self.binary(snapshot.read_bytes(), "text/html; charset=utf-8", "original.html")
        if action == "/download":
            if job["status"] != "done":
                return self.reply({"errcode": -1, "errmsg": "PDF not ready"}, 409)
            try:
                data = (job["directory"] / "document.pdf").read_bytes()
            except FileNotFoundError:
                return self.reply({"errcode": -1, "errmsg": "Expired"}, 404)
            return self.binary(data, "application/pdf", job.get("filename", "chat.pdf"))
        result = {key: value for key, value in job.items() if key not in ("directory", "created")}
        result.update(errcode=0, jobId=job_id)
        if job["status"] == "done":
            result["downloadUrl"] = f"http://127.0.0.1:{self.server.server_port}/api/pdf/v1/{job_id}/download"
        if (job["directory"] / "original.html").is_file():
            result["htmlUrl"] = f"http://127.0.0.1:{self.server.server_port}/api/pdf/v1/{job_id}/html"
        self.reply(result)

    def binary(self, data, mime, filename=None):
        self.headers_for(200, mime)
        if filename:
            fallback = "original.html" if mime.startswith("text/html") else "chat.pdf"
            self.send_header("Content-Disposition", f"attachment; filename=\"{fallback}\"; filename*=UTF-8''" + quote(filename))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        # No chat bodies or account data in access logs.
        print(format % args, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Local PDF server: http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        POOL.shutdown(wait=True)


if __name__ == "__main__":
    main()
