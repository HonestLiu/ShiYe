"""Container probe; the token stays in the request header, never the command line."""
import json
import os
from urllib.request import Request, build_opener, ProxyHandler

request = Request("http://127.0.0.1:" + os.environ.get("LOCAL_EXPORT_PORT", "8765") + "/health")
token = os.environ.get("LOCAL_EXPORT_API_TOKEN", "")
if token:
    request.add_header("Authorization", "Bearer " + token)
with build_opener(ProxyHandler({})).open(request, timeout=4) as response:
    health = json.load(response)
if not health.get("ok"):
    raise SystemExit(1)
