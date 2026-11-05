"""Render a frozen, self-contained webpage locally with sandboxed Chromium."""
import html
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import local_state

ROOT = Path(__file__).resolve().parent
LOCAL_MODULE = ROOT / "node_modules/playwright-core"
DEFAULT_MODULE = LOCAL_MODULE if LOCAL_MODULE.exists() else Path.home() / ".local/lib/node_modules/rea-agents/node_modules/playwright-core"
EXECUTABLES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Helium.app/Contents/MacOS/Helium",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)
CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"


def availability():
    configured = os.environ.get("LOCAL_EXPORT_CHROMIUM_EXECUTABLE")
    executable = configured if configured and Path(configured).is_file() else None
    if not configured:
        executable = next((path for path in EXECUTABLES if Path(path).is_file()), None)
        executable = executable or shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
    module = Path(os.environ.get("LOCAL_EXPORT_PLAYWRIGHT_MODULE", DEFAULT_MODULE)).expanduser()
    node = os.environ.get("LOCAL_EXPORT_NODE") or shutil.which("node")
    problems = []
    if not executable:
        problems.append("Chromium executable not found; configure LOCAL_EXPORT_CHROMIUM_EXECUTABLE")
    if not node or not Path(node).is_file():
        problems.append("Node executable not found; configure LOCAL_EXPORT_NODE")
    if not module.exists():
        problems.append("playwright-core not found; configure LOCAL_EXPORT_PLAYWRIGHT_MODULE")
    return {"available": not problems, "node": node, "executable": executable,
            "playwrightModule": str(module), "problems": problems,
            "sandboxEnabled": True, "startupVerified": False}


def clean_css(value):
    if not isinstance(value, str):
        raise ValueError("Frozen CSS must be a string")
    # Resource interception and CSP remain the final boundary even for unusual
    # CSS escape syntax. Reject ordinary external references instead of silently
    # rendering a snapshot with missing network assets.
    decoded = re.sub(r"\\([0-9a-fA-F]{1,6})\s?", lambda match: chr(int(match[1], 16)) if int(match[1], 16) <= 0x10FFFF else "", value)
    if re.search(r"@import\b", decoded, re.I):
        raise ValueError("Frozen CSS must not import external stylesheets")
    for match in re.finditer(r"url\(\s*(['\"]?)(.*?)\1\s*\)", decoded, re.I | re.S):
        address = match[2].strip()
        if address and not address.startswith(("data:", "#")):
            raise ValueError("Frozen CSS contains an external resource; embed it before export")
    return value.replace("</", "<\\/")


class StaticHTML(HTMLParser):
    BLOCK = {"script", "iframe", "object", "embed", "applet", "template", "noscript"}
    VOID = {"area", "br", "col", "hr", "img", "input", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.blocked = []
        self.styles = []
        self.style_buffer = []
        self.wrapper_attrs = {}

    def handle_starttag(self, tag, attrs):
        if self.blocked:
            if tag in self.BLOCK and tag not in ("embed",):
                self.blocked.append(tag)
            return
        if tag in self.BLOCK:
            if tag != "embed":
                self.blocked.append(tag)
            return
        # Supply our own document wrapper/CSP. External head resources and meta
        # refresh are never copied into the downloadable snapshot.
        if tag in ("head", "meta", "link", "base", "style", "title"):
            if tag in ("style", "title"):
                self.blocked.append(tag)
                if tag == "style":
                    self.style_buffer = []
            return
        safe = []
        for name, value in attrs:
            lower = name.lower()
            if lower.startswith("on") or lower in ("srcdoc", "nonce", "integrity", "action", "formaction", "srcset", "ping"):
                continue
            if value is None:
                safe.append(name)
                continue
            if lower == "style":
                value = clean_css(value)
            elif lower in ("src", "poster", "background", "href", "xlink:href"):
                address = value.strip()
                if lower in ("href", "xlink:href") and tag == "a":
                    if not re.match(r"^(?:https?://|mailto:|#)", address, re.I):
                        continue
                elif address and not address.startswith(("data:", "#")):
                    raise ValueError("Frozen HTML contains an external resource; embed it before export")
            safe.append(name + '="' + html.escape(value, quote=True) + '"')
        if tag in ("html", "body"):
            self.wrapper_attrs[tag] = " ".join(safe)
        else:
            self.parts.append("<" + tag + (" " + " ".join(safe) if safe else "") + ">")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.blocked:
            if tag == self.blocked[-1]:
                self.blocked.pop()
                if tag == "style":
                    self.styles.append(clean_css("".join(self.style_buffer)))
            return
        if tag not in self.VOID and tag not in ("html", "head", "body", "meta", "link", "base", "style", "title"):
            self.parts.append("</" + tag + ">")

    def handle_data(self, data):
        if self.blocked and self.blocked[-1] == "style":
            self.style_buffer.append(data)
        elif not self.blocked:
            self.parts.append(html.escape(data, quote=False))


def prepare_document(payload):
    document = payload.get("webDocument")
    if not isinstance(document, dict) or not isinstance(document.get("html"), str) or not document["html"].strip():
        raise ValueError("Chromium PDF requires webDocument.html containing a frozen webpage")
    css = clean_css(document.get("css", ""))
    try:
        width = float(document.get("width", 1000))
    except (ValueError, TypeError):
        raise ValueError("webDocument.width must be a finite number")
    if not math.isfinite(width) or not 240 <= width <= 5000:
        raise ValueError("webDocument.width must be between 240 and 5000 CSS pixels")
    theme = document.get("theme", "light")
    if theme not in ("light", "dark"):
        raise ValueError("webDocument.theme must be light or dark")
    parser = StaticHTML()
    parser.feed(document["html"])
    parser.close()
    options = payload.get("options") or {}
    language = str(options.get("lang", "zh-CN"))
    if not re.fullmatch(r"[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*", language):
        language = "zh-CN"
    title = (options.get("contentTitle") or payload.get("title") or "聊天导出")
    root_attributes = parser.wrapper_attrs.get("html", f'lang="{language}" class="{theme}"')
    body_attributes = parser.wrapper_attrs.get("body", "")
    css = "\n".join([*parser.styles, css])
    wrapper = f'<!doctype html><html {root_attributes}><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{html.escape(CSP, quote=True)}"><meta name="viewport" content="width={int(width)}"><title>{html.escape(str(title))}</title><style>html,body{{margin:0;padding:0}}*,*::before,*::after{{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}}\n{css}</style></head><body {body_attributes}>{"".join(parser.parts)}</body></html>'
    return {"html": wrapper, "width": int(width), "theme": theme, "options": options,
            "messageCount": document.get("messageCount"), "domCount": document.get("domCount"),
            "fallbackCount": document.get("fallbackCount", 0), "warnings": document.get("warnings", [])}


def render(payload, directory, prepared=None):
    info = availability()
    if not info["available"]:
        raise RuntimeError("Chromium renderer unavailable: " + "; ".join(info["problems"]))
    snapshot = prepared or prepare_document(payload)
    (directory / "original.html").write_text(snapshot["html"], encoding="utf-8")
    spec = {"input": str((directory / "original.html").resolve()),
            "output": str((directory / "document.pdf").resolve()),
            "width": snapshot["width"], "theme": snapshot["theme"], "options": snapshot["options"],
            "executable": info["executable"], "playwrightModule": info["playwrightModule"],
            "timeoutMs": int(os.environ.get("LOCAL_EXPORT_RENDER_TIMEOUT_SECONDS", "600")) * 1000,
            "dataDir": str(local_state.data_dir()), "publicOrigin": os.environ.get("LOCAL_EXPORT_PUBLIC_URL", "")}
    spec_path = directory / "chromium-job.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    process = subprocess.Popen([info["node"], str(ROOT / "render-webpage.mjs"), str(spec_path.resolve())],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=directory,
                               start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=spec["timeoutMs"] / 1000 + 30)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise RuntimeError("Chromium rendering timed out; increase LOCAL_EXPORT_RENDER_TIMEOUT_SECONDS for unusually large documents")
    if process.returncode:
        raise RuntimeError("Chromium PDF rendering failed: " + (stderr.strip() or stdout.strip() or "browser exited unexpectedly")[-6000:])
    output = directory / "document.pdf"
    if not output.exists() or output.open('rb').read(5) != b'%PDF-':
        raise RuntimeError("Chromium did not produce a valid PDF; no Pandoc fallback was used")
    return json.loads(stdout.strip().splitlines()[-1]) if stdout.strip() else {"engine": "chromium"}
