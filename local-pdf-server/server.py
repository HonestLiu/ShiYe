#!/usr/bin/env python3
"""Local or authenticated self-hosted PDF service. Python standard library HTTP."""
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
import secrets
from email.parser import BytesParser
from email.policy import default as email_policy
from urllib.parse import quote
from http.cookies import SimpleCookie, CookieError

import local_images
import local_state
import pdf_layout
import chromium_renderer
import server_security
import pdf_transfers

ROOT = Path(__file__).resolve().parent
JOBS = {}
LOCK = threading.Lock()
POOL = ThreadPoolExecutor(max_workers=2)
MAX_BODY = 64 * 1024 * 1024
WEB_TOKEN = secrets.token_urlsafe(32)


def command(args, cwd, stdin=None):
    env = dict(os.environ, openin_any="p", openout_any="p")
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, cwd=cwd, env=env,
                               start_new_session=True)
    try:
        stdout, stderr = process.communicate(stdin, timeout=int(os.environ.get('LOCAL_EXPORT_RENDER_TIMEOUT_SECONDS','600')))
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise RuntimeError("PDF conversion timed out; increase LOCAL_EXPORT_RENDER_TIMEOUT_SECONDS for unusually large documents")
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


def cleanup_job_files(directory):
    for item in directory.iterdir():
        if item.name not in ('document.pdf','original.html'):
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink(missing_ok=True)


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
            with LOCK:
                job['renderStats'] = result
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
        cleanup_job_files(directory)
        local_state.usage({"cmd": "report", "payload": {"format": "pdf"}})
        with LOCK:
            job.update(status="done", engine=engine, filename=pdf_layout.safe_filename(payload), fileSizeMB=round((directory / "document.pdf").stat().st_size / 1048576, 3))
            save_job(job_id)
    except Exception as error:
        if job.get("engine") == "chromium":
            local_state.put("chromium:last-render", {"ok": False, "at": time.time(), "error": str(error)})
        with LOCK:
            job.update(status="failed", errmsg=str(error))
            save_job(job_id)
    finally:
        # Keep a self-contained, script-free HTML alternative for webpage jobs.
        cleanup_job_files(job['directory'])


class Handler(BaseHTTPRequestHandler):
    def public_origin(self):
        configured = getattr(self.server, "public_url", "")
        if configured:
            return configured
        host = self.headers.get('Host', '').lower()
        if host in {f'localhost:{self.server.server_port}', f'127.0.0.1:{self.server.server_port}'}:
            return 'http://' + host
        return f"http://127.0.0.1:{self.server.server_port}"

    def resource_url(self, path):
        return self.public_origin() + server_security.signed_path(path, getattr(self.server, "api_token", ""))

    def allowed(self):
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        own_origin = self.public_origin()
        local_origins = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
        hosts = {urlsplit(value).netloc for value in local_origins | {own_origin}}
        trusted_origin = not origin or origin.startswith("chrome-extension://")
        if origin in local_origins | {own_origin}:
            trusted_origin = self.command != "POST" or secrets.compare_digest(self.headers.get("X-Local-CSRF", "").encode(), WEB_TOKEN.encode())
        return host.lower() in hosts and trusted_origin

    def authenticated(self):
        token = getattr(self.server, "api_token", "")
        if not token:
            return True
        if secrets.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + token).encode()):
            return True
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            value = cookie.get("export_session")
            if value and server_security.valid_session(token, value.value):
                return True
        except (ValueError, TypeError, CookieError):
            pass
        return self.command == "GET" and server_security.valid_download(self.path, token)

    def require_auth(self):
        if self.authenticated():
            return True
        self.reply({"errcode": -3, "errmsg": "请登录服务或检查访问令牌", "requiresAuth": True}, 401)
        return False

    def headers_for(self, code, mime):
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Local-CSRF")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def reply(self, data, code=200, extra_headers=None):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.headers_for(code, "application/json; charset=utf-8")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
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
        if not self.require_auth():
            return
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
            if self.path in ("/api/session", "/api/logout"):
                token = getattr(self.server, "api_token", "")
                value = server_security.session_cookie(token) if token and self.path == "/api/session" else ""
                cookie = "export_session=" + value + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + ("43200" if value else "0")
                if self.public_origin().startswith("https:"):
                    cookie += "; Secure"
                return self.reply({"errcode": 0}, extra_headers={"Set-Cookie": cookie})
            if self.path == "/api/pdf/uploads":
                return self.reply(pdf_transfers.begin(request.get("size")))
            transfer = re.fullmatch(r"/api/pdf/uploads/([a-f0-9]{32})/(chunk|commit|cancel)", self.path)
            if transfer:
                identifier, action = transfer.groups()
                if action == "chunk":
                    return self.reply(pdf_transfers.append(identifier, request.get("index"), request.get("data")))
                if action == "cancel":
                    return self.reply(pdf_transfers.cancel(identifier))
                return self.create_pdf(pdf_transfers.finish(identifier))
            routes = {"/api/account": local_state.account, "/api/usage": local_state.usage,
                      "/api/config/v3": local_state.config, "/api/feedback/v1": local_state.feedback,
                      "/api/settings": local_state.settings}
            if self.path in routes:
                return self.reply(routes[self.path](request))
            if self.path != "/api/pdf/v1":
                return self.reply({"errcode": -1, "errmsg": "Not found"}, 404)
            if request.get("cmd", "create") != "create":
                raise ValueError("Unsupported command")
            return self.create_pdf(request.get("payload", request))
        except (ValueError, TypeError, AttributeError) as error:
            self.reply({"errcode": -1, "errmsg": str(error)}, 400)
        except (OSError, subprocess.SubprocessError) as error:
            self.reply({"errcode": -2, "errmsg": str(error)}, 500)

    def create_pdf(self, payload):
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
            JOBS[job_id] = {"status": "queued", "engine": engine, "filename": pdf_layout.safe_filename(payload), "directory": directory, "created": time.time()}
            if prepared:
                (directory / "original.html").write_text(prepared["html"], encoding="utf-8")
                JOBS[job_id].update({key: prepared[key] for key in ('messageCount','domCount','fallbackCount','warnings')})
            save_job(job_id)
        POOL.submit(generate, job_id, payload, prepared)
        result = {"errcode": 0, "jobId": job_id, "status": "queued", "engine": engine}
        if prepared:
            result["htmlUrl"] = self.resource_url(f"/api/pdf/v1/{job_id}/html")
        self.reply(result)

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
                return self.reply({"errcode": 0, "url": self.resource_url(f"/api/file/{name}"), "mime": mime})
        raise ValueError("No file part supplied")

    def do_GET(self):
        if not self.allowed():
            return self.reply({"errcode": -1, "errmsg": "Origin/Host rejected"}, 403)
        path = urlsplit(self.path).path
        assets = {"/": ("local.html", "text/html; charset=utf-8"),
                  "/local.html": ("local.html", "text/html; charset=utf-8"),
                  "/local.js": ("local.js", "text/javascript; charset=utf-8"),
                  "/local.css": ("local.css", "text/css; charset=utf-8")}
        if path in assets:
            name, mime = assets[path]
            data = (ROOT / name).read_bytes()
            if name == "local.html":
                data = data.replace(b"<head>", ('<head><meta name="local-csrf" content="' + WEB_TOKEN + '">').encode(), 1)
            return self.binary(data, mime)
        if not self.require_auth():
            return
        if path == "/api/jobs":
            with local_state.connect() as connection:
                keys = [row[0][4:] for row in connection.execute("SELECT key FROM settings WHERE key GLOB 'job:*'")]
            jobs = []
            for key in keys:
                if not re.fullmatch(r"[a-f0-9]{32}", key):
                    continue
                job = find_job(key)
                if job:
                    item = {field: value for field, value in job.items() if field != "directory"}
                    item["jobId"] = key
                    if job["status"] == "done" and (job["directory"] / "document.pdf").is_file():
                        item["downloadUrl"] = self.resource_url(f"/api/pdf/v1/{key}/download")
                    if (job["directory"] / "original.html").is_file():
                        item["htmlUrl"] = self.resource_url(f"/api/pdf/v1/{key}/html")
                    jobs.append(item)
            jobs.sort(key=lambda job: job.get("created", 0), reverse=True)
            return self.reply({"errcode": 0, "items": jobs[:100], "total": len(jobs)})
        if path == "/health":
            engines = engine_health()
            return self.reply({"ok": any(item["available"] for item in engines.values()), "engine": "chromium / pandoc + xelatex", "engines": engines, "dependencies": engines["pandoc"]["dependencies"], "supportsWebDocument": True, "supportsMarkdownFallback": True,"supportsChunkedPdf":True,"maxPayloadMB":int(os.environ.get('LOCAL_EXPORT_MAX_PAYLOAD_MB','256')),"remoteImageFetch": False, "local": not bool(getattr(self.server, 'api_token', '')), "authenticationRequired": bool(getattr(self.server, 'api_token', '')), "version": 4})
        routes = {"/api/account": local_state.account, "/api/usage": local_state.usage,
                  "/api/config/v3": local_state.config, "/api/feedback/v1": local_state.feedback_list,
                  "/api/settings": local_state.settings}
        if path in routes:
            return self.reply(routes[path]())
        if path.startswith("/api/file/"):
            image = local_images.owned_path(path.removeprefix("/api/file/"))
            if image is None:
                return self.reply({"errcode": -1, "errmsg": "Unknown image"}, 404)
            return self.serve_file(image, "image/png" if image.suffix == ".png" else "image/jpeg")
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
            return self.serve_file(snapshot, "text/html; charset=utf-8", "original.html")
        if action == "/download":
            if job["status"] != "done":
                return self.reply({"errcode": -1, "errmsg": "PDF not ready"}, 409)
            output = job["directory"] / "document.pdf"
            if not output.is_file():
                return self.reply({"errcode": -1, "errmsg": "Expired"}, 404)
            return self.serve_file(output, "application/pdf", job.get("filename", "chat.pdf"))
        result = {key: value for key, value in job.items() if key not in ("directory", "created")}
        result.update(errcode=0, jobId=job_id)
        if job["status"] == "done":
            result["downloadUrl"] = self.resource_url(f"/api/pdf/v1/{job_id}/download")
        if (job["directory"] / "original.html").is_file():
            result["htmlUrl"] = self.resource_url(f"/api/pdf/v1/{job_id}/html")
        self.reply(result)

    def serve_file(self, path, mime, filename=None):
        with path.open('rb') as stream:
            self.headers_for(200, mime)
            if filename:
                fallback = "original.html" if mime.startswith("text/html") else "chat.pdf"
                self.send_header("Content-Disposition", f"attachment; filename=\"{fallback}\"; filename*=UTF-8''" + quote(filename))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(os.fstat(stream.fileno()).st_size))
            self.end_headers()
            shutil.copyfileobj(stream, self.wfile, length=1024*1024)

    def binary(self, data, mime, filename=None):
        self.headers_for(200, mime)
        if filename:
            fallback = "original.html" if mime.startswith("text/html") else "chat.pdf"
            self.send_header("Content-Disposition", f"attachment; filename=\"{fallback}\"; filename*=UTF-8''" + quote(filename))
        self.send_header("X-Content-Type-Options", "nosniff")
        if mime.startswith("text/html") and not filename:
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        # No chat bodies or account data in access logs.
        print((format % args).replace(self.path, urlsplit(self.path).path), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=int(os.environ.get("LOCAL_EXPORT_PORT", "8765")))
    parser.add_argument("--host", default=os.environ.get("LOCAL_EXPORT_HOST", "127.0.0.1"))
    args = parser.parse_args()
    public_url = os.environ.get("LOCAL_EXPORT_PUBLIC_URL", "")
    try:
        public_url = server_security.normalize_origin(public_url) if public_url else ""
    except ValueError as error:
        parser.error(str(error))
    if public_url:
        os.environ['LOCAL_EXPORT_PUBLIC_URL'] = public_url
    token = os.environ.get("LOCAL_EXPORT_API_TOKEN", "")
    if token and not re.fullmatch(r"[\x21-\x7e]{1,1024}", token):
        parser.error("LOCAL_EXPORT_API_TOKEN must be a printable ASCII token without whitespace, at most 1024 characters")
    remote_bind = args.host not in ("127.0.0.1", "localhost")
    remote_public = bool(public_url) and urlsplit(public_url).hostname not in ("127.0.0.1", "localhost", "::1")
    if (remote_bind and not public_url) or ((remote_bind or remote_public) and len(token) < 24):
        parser.error("Remote listening requires LOCAL_EXPORT_PUBLIC_URL and LOCAL_EXPORT_API_TOKEN (at least 24 characters)")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.public_url, server.api_token = public_url, token
    print(f"PDF service: {public_url or f'http://127.0.0.1:{args.port}'}", flush=True)
    def stop_service(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_service)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        POOL.shutdown(wait=True)


if __name__ == "__main__":
    main()
