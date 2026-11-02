"""Durable local profile, configuration, usage, and feedback; no remote APIs."""
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid
from contextlib import contextmanager

DEFAULT_PROFILE = {"cusId": "local-user", "email": "local@localhost", "name": "本地用户"}


def data_dir():
    path = Path(os.environ.get("LOCAL_EXPORT_DATA_DIR", Path(__file__).parent / "data")).resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def connect():
    connection = sqlite3.connect(data_dir() / "local.sqlite3", timeout=15)
    connection.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    connection.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created REAL NOT NULL, payload TEXT NOT NULL)")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def get(key, default=None):
    with connect() as connection:
        row = connection.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def put(key, value):
    with connect() as connection:
        connection.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, json.dumps(value, ensure_ascii=False)))


def event(kind, payload):
    identifier = uuid.uuid4().hex
    with connect() as connection:
        connection.execute("INSERT INTO events VALUES(?,?,?,?)", (identifier, kind, time.time(), json.dumps(payload, ensure_ascii=False)))
    return identifier


def account(request=None):
    request = request or {}
    command = request.get("cmd", "getinfo")
    profile = get("profile", DEFAULT_PROFILE)
    if command in ("update", "save", "login", "register"):
        update = request.get("payload") or {}
        profile = {**profile, **{key: str(update[key])[:256] for key in ("name", "email") if key in update}}
        put("profile", profile)
    elif command not in ("getinfo", "get", "logout"):
        raise ValueError("Unknown local account command")
    # isPro is a compatibility flag for the independently implemented local
    # renderer. This is not an account or entitlement on the original service.
    return {"errcode": 0, **profile, "isPro": True, "local": True, "plan": "local",
            "planName": "Local", "status": "active", "updatedAt": int(time.time() * 1000)}


def usage(request=None):
    request = request or {}
    command = request.get("cmd", "get")
    if command in ("report", "increment", "record"):
        payload = request.get("payload") or {}
        file_format = payload.get("format", payload.get("type", "unknown"))
        if file_format not in ("pdf", "md", "txt", "csv", "json"):
            raise ValueError("Unknown export format")
        event("export", {"format": file_format})
    elif command != "get":
        raise ValueError("Unknown usage command")
    with connect() as connection:
        rows = connection.execute("SELECT payload,created FROM events WHERE kind='export'").fetchall()
    counts = {key: 0 for key in ("pdf", "md", "txt", "csv", "json")}
    today = time.strftime("%Y-%m-%d")
    daily = 0
    monthly = 0
    pdf_days = {}
    for payload, created in rows:
        file_format = json.loads(payload).get("format")
        if file_format in counts:
            counts[file_format] += 1
        if file_format == "pdf":
            day = time.strftime("%Y%m%d", time.localtime(created))
            pdf_days[day] = pdf_days.get(day, 0) + 1
        daily += time.strftime("%Y-%m-%d", time.localtime(created)) == today
        monthly += time.strftime("%Y-%m", time.localtime(created)) == today[:7]
    return {"errcode": 0, "hasExceed": False, "local": True, "unlimited": True,
            "total": len(rows), "today": daily, "counts": counts,
            "used": len(rows), "limit": None, "pdf": counts["pdf"], "pdfCount": counts["pdf"],
            "dayId": today, "dailyUsage": daily, "monthlyUsage": monthly, "quota": None,
            "usage": {"pdfGen": {**{today.replace("-", ""): 0}, **pdf_days}}}


def config(request=None):
    request = request or {}
    if request.get("cmd") in ("save", "update", "set"):
        value = request.get("payload") or {}
        selectors = value.get("selectors", {})
        if not isinstance(selectors, dict) or not all(isinstance(key, str) and isinstance(item, (str, list)) for key, item in selectors.items()):
            raise ValueError("Invalid selector configuration")
        put("config", {"selectors": selectors})
    return {"errcode": 0, "local": True, "version": 1, **get("config", {"selectors": {}})}


def feedback(payload):
    if not isinstance(payload, dict):
        raise ValueError("Feedback must be an object")
    # Diagnostic export is local, but copying all browser storage is unnecessary.
    payload = {key: value for key, value in payload.items() if key not in ("storage", "auth", "token")}
    identifier = event("feedback", payload)
    return {"errcode": 0, "errmsg": "已保存到本机", "id": identifier, "feedbackId": identifier, "local": True}


def feedback_list():
    with connect() as connection:
        rows = connection.execute("SELECT id,created,payload FROM events WHERE kind='feedback' ORDER BY created DESC LIMIT 100").fetchall()
    return {"errcode": 0, "items": [{"id": key, "created": created, "data": json.loads(payload)} for key, created, payload in rows]}


def settings(request=None):
    allowed = {"commonOptions", "pdfOptions", "userInfo", "exportType", "selectType"}
    def merge(previous, update):
        result = dict(previous)
        for key, value in update.items():
            result[key] = merge(result.get(key, {}), value) if isinstance(result.get(key, {}), dict) and isinstance(value, dict) else value
        return result

    current = get("extension-settings", {})
    web_revision = get("extension-settings-web-revision", 0)
    if request is not None:
        update = request.get("settings")
        if not isinstance(update, dict) or set(update) - allowed:
            raise ValueError("Invalid export preference keys")
        for key, value in update.items():
            if key in ("commonOptions", "pdfOptions", "userInfo") and not isinstance(value, dict):
                raise ValueError("Preference must be an object: " + key)
        with connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT value FROM settings WHERE key='extension-settings'").fetchone()
            current = merge(json.loads(row[0]) if row else {}, update)
            connection.execute("INSERT INTO settings(key,value) VALUES('extension-settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(current, ensure_ascii=False),))
            if request.get("source") == "web":
                row = connection.execute("SELECT value FROM settings WHERE key='extension-settings-web-revision'").fetchone()
                web_revision = (json.loads(row[0]) if row else 0) + 1
                connection.execute("INSERT INTO settings(key,value) VALUES('extension-settings-web-revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(web_revision),))
    return {"errcode": 0, "settings": current, "webRevision": web_revision}
