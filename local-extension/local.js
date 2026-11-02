const $ = selector => document.querySelector(selector);
const PREFS = ["commonOptions", "pdfOptions", "userInfo", "exportType", "selectType"];
const inExtension = typeof globalThis.chrome?.runtime?.sendMessage === 'function';
const csrf = document.querySelector('meta[name="local-csrf"]')?.content || '';

async function api(path, body) {
  if (!inExtension) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Local-CSRF': csrf },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || data.errcode) throw new Error(data.errmsg || '本地服务出错');
    return data;
  }
  const response = await chrome.runtime.sendMessage({ cmd: "local_request", payload: { path, method: body === undefined ? "GET" : "POST", body } });
  if (response.errcode) throw new Error(response.errmsg);
  const data = JSON.parse(response.text);
  if (response.status >= 400 || data.errcode) throw new Error(data.errmsg || "本地服务出错");
  return data;
}

async function preferences(keys = PREFS) {
  if (inExtension) return chrome.storage.local.get(keys);
  return (await api('/api/settings')).settings || {};
}

async function savePreferences(settings) {
  await api('/api/settings', { settings, ...(!inExtension ? { source: 'web' } : {}) });
  if (inExtension) await chrome.storage.local.set(settings);
}

let jobTimer;
async function loadJobs() {
  clearTimeout(jobTimer);
  const data = await api('/api/jobs');
  const list = $('#jobs-list');
  list.replaceChildren();
  const statuses = { queued: '排队中', processing: '生成中', done: '已完成', failed: '失败' };
  for (const job of data.items || []) {
    const row = document.createElement('tr');
    const title = document.createElement('td');
    title.textContent = job.filename || 'PDF 任务';
    const engine = document.createElement('span');engine.className='job-engine';engine.textContent=job.engine === 'chromium' ? '网页原貌' : 'Pandoc';title.append(engine);
    const date = document.createElement('td');
    const time = document.createElement('time');
    time.dateTime = new Date(job.created * 1000).toISOString();time.textContent = new Date(job.created * 1000).toLocaleString('zh-CN');date.append(time);
    const state = document.createElement('td');state.textContent=statuses[job.status] || job.status;
    if (job.errmsg) { const detail=document.createElement('details');const summary=document.createElement('summary');summary.textContent='查看错误';const error=document.createElement('p');error.className='job-error';error.textContent=job.errmsg;detail.append(summary,error);state.append(detail); }
    const actions = document.createElement('td');
    for (const [field, label, suffix] of [['downloadUrl','下载 PDF','download'],['htmlUrl','下载快照','html']]) {
      if (!job[field] || !/^[a-f0-9]{32}$/.test(job.jobId)) continue;
      const link=document.createElement('a');
      link.href=(inExtension ? 'http://127.0.0.1:8765' : '')+'/api/pdf/v1/'+job.jobId+'/'+suffix;
      link.textContent=label;actions.append(link);
    }
    row.append(title,date,state,actions);list.append(row);
  }
  $('#jobs-status').textContent = data.total ? `共 ${data.total} 个任务，显示最近 ${data.items.length} 个。` : '尚无导出记录。可在下方生成 PDF，或从 ChatGPT 扩展导出。';
  if ((data.items || []).some(job => ['queued','processing'].includes(job.status))) {
    jobTimer=setTimeout(()=>loadJobs().catch(error=>{ $('#jobs-status').textContent=error.message; }),2000);
  }
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
    $("#status").textContent = health.ok ? "已连接 · PDF 与图片由本机处理" : "已连接 · PDF 引擎尚未就绪，请检查下方依赖状态。";
    $("#name").value = account.name || "本地用户";
    $("#email").value = account.email || "";
    $("#usage").textContent = "本机导出用量：" + JSON.stringify(usage.counts || usage.usage || {});
    $("#selectors").value = JSON.stringify(config.selectors || {}, null, 2);
    const chromium = health.engines?.chromium;
    $("#engine-status").textContent = chromium?.available
      ? chromium.startupVerified ? 'Chromium 已成功生成过 PDF。' : 'Chromium 依赖已找到，实际渲染状态以导出结果为准。'
      : 'Chromium 尚未就绪：' + (chromium?.problems || ['请重启新版服务']).join('；');
    const stored = await preferences(['pdfOptions', 'lastWebPdfJob']);
    const renderer = stored.pdfOptions?.renderer || 'chromium';
    const choice = document.querySelector(`#renderer-form input[value="${renderer === 'pandoc' ? 'pandoc' : 'chromium'}"]`);
    if (choice) choice.checked = true;
    $('#default-toc').checked = stored.pdfOptions?.toc === true;
    const snapshot = stored.lastWebPdfJob;
    if (snapshot?.htmlUrl?.startsWith('http://127.0.0.1:8765/api/pdf/v1/')) {
      $('#last-snapshot').href = snapshot.htmlUrl;
      $('#last-snapshot').hidden = false;
    }
    await Promise.all([loadFeedback(),loadJobs()]);
  } catch (error) { $("#status").textContent = error.message + " 请启动 local-pdf-server/start.command，然后重新检查连接。"; }
}

function form(selector, resultSelector, action) {
  $(selector).addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try { $(resultSelector).textContent = (await action()) || "已保存到本机。"; }
    catch (error) { $(resultSelector).textContent = error.message; }
    finally { button.disabled = false; }
  });
}

form("#profile", "#profile-result", async () => {
  const result = await api('/api/account', { cmd: "update", payload: { name: $("#name").value, email: $("#email").value } });
  if (result.errcode || result.rslt?.errcode) throw new Error(result.errmsg || result.rslt?.errmsg || "保存失败");
  if (inExtension) await chrome.storage.local.set({ userInfo: { name: $("#name").value, email: $("#email").value } });
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
form('#renderer-form', '#renderer-result', async () => {
  const renderer = document.querySelector('#renderer-form input:checked')?.value;
  if (!['chromium', 'pandoc'].includes(renderer)) throw new Error('请选择导出方式');
  const stored = await preferences('pdfOptions');
  const pdfOptions = { ...stored.pdfOptions, renderer, toc: $('#default-toc').checked, localTocOptInVersion: 1 };
  await savePreferences({ pdfOptions });
});
$("#refresh").addEventListener("click", refresh);
$('#options').hidden = !inExtension;
$("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#backup").addEventListener("click", async () => {
  try {
    const settings = await preferences();
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
    await savePreferences(settings);
    $("#settings-result").textContent = "导出设置已恢复。请刷新 ChatGPT 页面。";
  } catch (error) { $("#settings-result").textContent = error.message; }
});
$('#markdown-file').addEventListener('change',async event=>{
  try {
    const file=event.target.files[0];if(!file)return;
    if(file.size>2*1024*1024)throw new Error('Markdown 文件不能超过 2 MiB');
    $('#markdown').value=await file.text();$('#document-title').value=file.name.replace(/\.(md|markdown|txt)$/i,'');
    $('#create-result').textContent='文件已读取，可检查正文后生成 PDF。';
  }catch(error){$('#create-result').textContent=error.message;}
});
form('#create-form','#create-result',async()=>{
  const markdown=$('#markdown').value;
  if(!markdown.trim())throw new Error('请输入 Markdown 正文');
  const options=(await preferences('pdfOptions')).pdfOptions || {};
  const result=await api('/api/pdf/v1',{engine:'pandoc',title:$('#document-title').value,markdown,
    options:{...options,toc:$('#create-toc').checked}});
  $('#create-result').textContent='任务已提交，正在生成 PDF…';
  await loadJobs();
  // Poll with a limit; long-running jobs remain visible in the history.
  for(let attempt=0;attempt<100;attempt++) {
    const job=await api('/api/pdf/v1/'+result.jobId);
    if(job.status==='failed')throw new Error(job.errmsg || 'PDF 生成失败');
    if(job.status==='done'){await loadJobs();return 'PDF 已生成，可在导出记录中下载。';}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  throw new Error('任务仍在处理中，请在导出记录中查看进度。');
});
refresh();
