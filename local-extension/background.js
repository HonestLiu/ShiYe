/* Local replacement service worker. No third-party network or analytics. */
const BASE = "http://127.0.0.1:8765";
const PREFS = ["commonOptions", "pdfOptions", "userInfo", "exportType", "selectType"];
let restoring = false;
let syncTimer;
let boot;
let reconciliation;
let serviceOnline = false;
let preferenceRevision = 0;

function validPath(path) {
  return typeof path === "string" && /^\/(?:health$|api\/)/.test(path) &&
    new URL(path, BASE).origin === BASE && !path.includes("..");
}

async function api(path, { method = "GET", body, upload, timeout = 180000 } = {}) {
  if (!validPath(path) || !["GET", "POST"].includes(method)) throw new Error("Unsupported local API request");
  const headers = {};
  let content;
  if (upload) {
    if (typeof upload.base64 !== "string" || upload.base64.length > 24 * 1024 * 1024) throw new Error("Image exceeds local upload limit");
    content = new FormData();
    const bytes = Uint8Array.from(atob(upload.base64), char => char.charCodeAt(0));
    content.append("file", new Blob([bytes], { type: upload.mime || "application/octet-stream" }), upload.name || "image.png");
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    content = typeof body === "string" ? body : JSON.stringify(body);
  }
  const response = await fetch(BASE + path, { method, headers, body: content, signal: AbortSignal.timeout(timeout) });
  const mime = response.headers.get("content-type") || "application/json";
  if (mime.startsWith("image/") || mime === "application/pdf") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return { status: response.status, mime, base64: btoa(binary) };
  }
  return { status: response.status, mime, text: await response.text() };
}

async function jsonApi(path, options) {
  const response = await api(path, options);
  let data;
  try { data = JSON.parse(response.text); } catch { throw new Error("Local service returned invalid JSON"); }
  if (response.status >= 400) throw new Error(data.errmsg || `Local service error ${response.status}`);
  return data;
}

async function cacheAccount(account) {
  const { session = {} } = await chrome.storage.local.get("session");
  await chrome.storage.local.set({
    session: { ...session, user: { cusId: "local", name: account.name || "本地用户", email: account.email || "" } },
    account_info: { ...account, updatedAt: Date.now() }
  });
  return account;
}

async function initialize() {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
  const stored = await chrome.storage.local.get(null);
  await cacheAccount(stored.account_info?.local ? stored.account_info : { errcode: 0, local: true, isPro: true, name: "本地用户", email: "" });
}

async function reconcile() {
  if (reconciliation) return reconciliation;
  reconciliation = (async () => {
    const [account, prefs] = await Promise.all([
      jsonApi("/api/account", { method: "POST", body: { cmd: "getinfo" }, timeout: 5000 }),
      jsonApi("/api/settings", { timeout: 5000 })
    ]);
    const stored = await chrome.storage.local.get(null);
    await cacheAccount(account);
    const missing = Object.fromEntries(PREFS.filter(key => stored[key] === undefined && prefs.settings?.[key] !== undefined).map(key => [key, prefs.settings[key]]));
    if (Object.keys(missing).length) {
      restoring = true;
      try { await chrome.storage.local.set(missing); } finally { restoring = false; }
    }
    const revision = preferenceRevision;
    const settings = await chrome.storage.local.get(PREFS);
    await jsonApi("/api/settings", { method: "POST", body: { settings }, timeout: 5000 });
    if (revision === preferenceRevision) await chrome.storage.local.set({ localSettingsDirty: false });
    serviceOnline = true;
  })();
  try { return await reconciliation; }
  catch (error) { serviceOnline = false; throw error; }
  finally { reconciliation = undefined; }
}

async function route(message) {
  switch (message.cmd) {
    case "local_ready": return { errcode: 0, local: true };
    case "local_request": return api(message.payload.path, message.payload);
    case "account": {
      const result = await jsonApi("/api/account", { method: "POST", body: message.payload });
      await cacheAccount(result);
      return { errcode: 0, rslt: result };
    }
    case "usage": return { errcode: 0, rslt: await jsonApi("/api/usage", { method: "POST", body: message.payload }) };
    case "feedback": return jsonApi("/api/feedback/v1", { method: "POST", body: message.data || {} });
    case "pdf": {
      const payload = message.payload || {};
      return payload.cmd === "status"
        ? jsonApi("/api/pdf/v1/" + encodeURIComponent(payload.payload?.jobId || ""))
        : jsonApi("/api/pdf/v1", { method: "POST", body: { cmd: "create", payload: payload.payload } });
    }
    case "open_options_page": await chrome.runtime.openOptionsPage(); return { errcode: 0 };
    default: throw new Error("Unknown local extension command");
  }
}

async function dispatch(message) {
  if (!boot) boot = initialize();
  await boot;
  let result;
  try { result = await route(message); }
  catch (error) { serviceOnline = false; throw error; }
  const stored = await chrome.storage.local.get("localSettingsDirty");
  if (message.cmd !== "open_options_page" && (message.cmd === "local_ready" || !serviceOnline || stored.localSettingsDirty)) {
    try { await reconcile(); }
    catch (error) { console.info("Existing browser settings retained; retry on next connection:", error.message); }
  }
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  dispatch(message).then(respond, error => respond({ errcode: -2, errmsg: `本地服务连接失败：${error.message}。请启动 local-pdf-server/start.command。` }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.runtime.setUninstallURL("");
  boot = initialize();
  await boot;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || restoring || !PREFS.some(key => key in changes)) return;
  preferenceRevision += 1;
  chrome.storage.local.set({ localSettingsDirty: true });
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      await reconcile();
    } catch (error) { console.info("Settings remain saved in the browser:", error.message); }
  }, 300);
});
