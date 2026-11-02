"""Origin validation and scoped credentials for a self-hosted single-user service."""
import hashlib
import hmac
import re
import time
from urllib.parse import urlsplit, parse_qs, urlencode


def normalize_origin(value):
    parsed = urlsplit(value)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or
            parsed.username or parsed.password or parsed.path not in ("", "/") or
            parsed.query or parsed.fragment):
        raise ValueError("Server URL must be an http(s) origin without a path, query or credentials")
    port = parsed.port  # Also validates malformed ports.
    host = parsed.hostname.lower()
    if any(char.isspace() for char in host):
        raise ValueError("Server URL contains an invalid host")
    host = '[' + host + ']' if ':' in host else host.encode('idna').decode('ascii')
    if port is not None and port != (443 if parsed.scheme == 'https' else 80):
        host += ':' + str(port)
    return f"{parsed.scheme}://{host}"


def digest(key, value):
    return hmac.new(key.encode(), value.encode(), hashlib.sha256).hexdigest()


def session_cookie(key):
    expires = str(int(time.time()) + 12 * 3600)
    return expires + "." + digest(key, "session:" + expires)


def valid_session(key, value):
    if not re.fullmatch(r"\d+\.[a-f0-9]{64}", value):
        return False
    expires, signature = value.split(".")
    return int(expires) >= time.time() and hmac.compare_digest(signature, digest(key, "session:" + expires))


def signed_path(path, key):
    if not key:
        return path
    expires = str(int(time.time()) + 900)
    signature = digest(key, "download:" + path + ":" + expires)
    return path + "?" + urlencode({"expires": expires, "signature": signature})


def valid_download(target, key):
    parsed = urlsplit(target)
    if not re.fullmatch(r"/api/(?:pdf/v1/[a-f0-9]{32}/(?:download|html)|file/[a-f0-9]{64}\.(?:png|jpg))", parsed.path):
        return False
    query = parse_qs(parsed.query)
    if any(len(query.get(field, [])) != 1 for field in ("expires", "signature")):
        return False
    expires, signature = query["expires"][0], query["signature"][0]
    return bool(re.fullmatch(r"\d{1,12}", expires) and re.fullmatch(r"[a-f0-9]{64}", signature) and int(expires) >= time.time() and
                hmac.compare_digest(signature, digest(key, "download:" + parsed.path + ":" + expires)))
