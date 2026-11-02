const $ = selector => document.querySelector(selector);
const PREFS = ["commonOptions", "pdfOptions", "userInfo", "exportType", "selectType"];

async function api(path, body) {
  const response = await chrome.runtime.sendMessage({ cmd: "local_request", payload: { path, method: body === undefined ? "GET" : "POST", body } });
  if (response.errcode) throw new Error(response.errmsg);
  const data = JSON.parse(response.text);
  if (response.status >= 400 || data.errcode) throw new Error(data.errmsg || "本地服务出错");
  return data;
}

async function loadFeedback() {
  const data = await api("/api/feedback/v1");
  const list = $("#feedback-list");
  list.replaceChildren();
  for (const item of (data.items || []).slice(0, 30)) {
    const li = document.createElement("li");
    li.textContent = typeof item === "string" ? item : JSON.stringify(item, null, 2);
    list.append(li);
  }
}

async function refresh() {
  $("#status").textContent = "正在检查连接…";
  try {
    const [health, account, usage, config] = await Promise.all([
      api("/health"), api("/api/account", { cmd: "getinfo" }), api("/api/usage", { cmd: "get" }), api("/api/config/v3")
    ]);
    if (!health.ok) throw new Error("本地服务未就绪");
    $("#status").textContent = "已连接 · PDF 与图片由本机处理";
    $("#name").value = account.name || "本地用户";
    $("#email").value = account.email || "";
    $("#usage").textContent = "本机导出用量：" + JSON.stringify(usage.counts || usage.usage || {});
    $("#selectors").value = JSON.stringify(config.selectors || {}, null, 2);
    await loadFeedback();
  } catch (error) { $("#status").textContent = error.message + " 请启动 local-pdf-server/start.command，然后重新检查连接。"; }
}

function form(selector, resultSelector, action) {
  $(selector).addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try { await action(); $(resultSelector).textContent = "已保存到本机。"; }
    catch (error) { $(resultSelector).textContent = error.message; }
    finally { button.disabled = false; }
  });
}

form("#profile", "#profile-result", async () => {
  const result = await chrome.runtime.sendMessage({ cmd: "account", payload: { cmd: "update", payload: { name: $("#name").value, email: $("#email").value } } });
  if (result.errcode || result.rslt?.errcode) throw new Error(result.errmsg || result.rslt?.errmsg || "保存失败");
  await chrome.storage.local.set({ userInfo: { name: $("#name").value, email: $("#email").value } });
});
form("#config-form", "#config-result", async () => {
  const selectors = JSON.parse($("#selectors").value);
  if (!selectors || Array.isArray(selectors) || typeof selectors !== "object") throw new Error("请输入 JSON 对象");
  await api("/api/config/v3", { cmd: "update", payload: { selectors } });
});
form("#feedback-form", "#feedback-result", async () => {
  await api("/api/feedback/v1", { type: "note", message: $("#message").value, context: "local-dashboard" });
  $("#message").value = "";
  await loadFeedback();
});
$("#refresh").addEventListener("click", refresh);
$("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#backup").addEventListener("click", async () => {
  try {
    const settings = await chrome.storage.local.get(PREFS);
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, settings }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "chatgpt-exporter-local-settings.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $("#settings-result").textContent = "设置备份已下载。";
  } catch (error) { $("#settings-result").textContent = error.message; }
});
$("#import").addEventListener("change", async event => {
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) throw new Error("备份文件不能超过 1 MiB");
    const data = JSON.parse(await file.text());
    if (!data.settings || typeof data.settings !== "object" || Array.isArray(data.settings)) throw new Error("备份格式无效");
    const settings = Object.fromEntries(PREFS.filter(key => key in data.settings).map(key => [key, data.settings[key]]));
    for (const key of ["commonOptions", "pdfOptions", "userInfo"]) {
      if (key in settings && (!settings[key] || typeof settings[key] !== "object" || Array.isArray(settings[key]))) throw new Error("备份中的 " + key + " 必须是对象");
    }
    if (settings.exportType && !["pdf", "md", "txt", "csv", "json"].includes(settings.exportType)) throw new Error("未知导出格式");
    if (settings.selectType && !["all", "questions", "answers", "none"].includes(settings.selectType)) throw new Error("未知消息选择类型");
    await api("/api/settings", { settings });
    await chrome.storage.local.set(settings);
    $("#settings-result").textContent = "导出设置已恢复。请刷新 ChatGPT 页面。";
  } catch (error) { $("#settings-result").textContent = error.message; }
});
refresh();
