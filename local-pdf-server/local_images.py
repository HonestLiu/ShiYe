"""Opaque local image storage and job-local copies, never remote URL fetching."""
import base64
import hashlib
import io
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit

from local_state import data_dir

MAX_IMAGE = 16 * 1024 * 1024


def identify(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif", "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    raise ValueError("Unsupported image: use PNG, JPEG, GIF, or WebP (SVG is not executed)")


def store(data):
    if not data or len(data) > MAX_IMAGE:
        raise ValueError("Image must be 1 byte to 16 MiB")
    extension, mime = identify(data)
    if extension in ("gif", "webp"):
        try:
            from PIL import Image
        except ImportError:
            if not Path("/usr/bin/sips").is_file():
                raise ValueError("GIF/WebP conversion requires Pillow; install python3-pil or use PNG/JPEG")
            with tempfile.TemporaryDirectory(prefix="local-image-") as directory:
                source = Path(directory) / ("source." + extension)
                destination = Path(directory) / "image.png"
                source.write_bytes(data)
                result = subprocess.run(["/usr/bin/sips", "-s", "format", "png", str(source), "--out", str(destination)], capture_output=True, timeout=30)
                if result.returncode or not destination.exists():
                    raise ValueError("Could not convert the supplied image; use PNG or JPEG")
                data = destination.read_bytes()
        else:
            try:
                with Image.open(io.BytesIO(data)) as image:
                    image.seek(0)
                    output = io.BytesIO()
                    image.convert("RGBA").save(output, format="PNG")
                    data = output.getvalue()
            except Exception as error:
                raise ValueError("Could not decode GIF/WebP image") from error
        extension, mime = "png", "image/png"
    digest = hashlib.sha256(data).hexdigest()
    name = f"{digest}.{extension}"
    directory = data_dir() / "files"
    directory.mkdir(exist_ok=True)
    path = directory / name
    if not path.exists():
        with tempfile.NamedTemporaryFile(dir=directory, suffix=".tmp", delete=False) as stream:
            stream.write(data)
            temporary = Path(stream.name)
        temporary.replace(path)
    return name, mime


def owned_path(name):
    if not re.fullmatch(r"[a-f0-9]{64}\.(png|jpg)", name):
        return None
    path = data_dir() / "files" / name
    return path if path.is_file() else None


def resolve_for_job(url, directory):
    if directory is None:
        return None
    if url.startswith("data:image/"):
        match = re.fullmatch(r"data:image/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)", url)
        if not match:
            return None
        name, _ = store(base64.b64decode(match[1], validate=True))
        source = owned_path(name)
    else:
        parsed = urlsplit(url)
        public = urlsplit(os.environ.get("LOCAL_EXPORT_PUBLIC_URL", ""))
        local = parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost")
        configured = bool(public.netloc) and (parsed.scheme, parsed.netloc.lower()) == (public.scheme, public.netloc.lower())
        relative = not parsed.scheme and not parsed.netloc
        if not (local or configured or relative) or not parsed.path.startswith("/api/file/"):
            return None
        source = owned_path(parsed.path.removeprefix("/api/file/"))
    if source is None:
        return None
    destination = directory / ("image-" + source.name)
    shutil.copyfile(source, destination)
    return destination.name
