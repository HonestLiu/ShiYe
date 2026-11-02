/* Isolated-world transport: content scripts never fetch HTTP loopback directly. */
(() => {
  const DEFAULT_BASE = "http://127.0.0.1:8765";
  let BASE = DEFAULT_BASE;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const blocked = url => /(^|\.)(chatgptexporter\.com|posthog\.com|amplitude\.com|sentry\.io)$/i.test(url.hostname);
  let renderer = 'chromium';
  const ready = chrome.runtime.sendMessage({ cmd: "local_ready" }).then(async result => {
    BASE = result.baseUrl || DEFAULT_BASE;
    const settings = await chrome.storage?.local?.get('pdfOptions');
    // Apply the new opt-in default once, including upgrades with the old default.
    // Subsequent loads retain the user's explicit choice.
    if (settings && settings.pdfOptions?.localTocOptInVersion !== 1) {
      await chrome.storage.local.set({ pdfOptions: { ...settings.pdfOptions, toc: false, localTocOptInVersion: 1 } });
    }
    renderer = settings?.pdfOptions?.renderer === 'pandoc' ? 'pandoc' : 'chromium';
    return result;
  });
  const pickers = new Set();
  function updatePickers() {
    for (const picker of pickers) {
      if (!picker.isConnected) { pickers.delete(picker); continue; }
      for (const input of picker.querySelectorAll('input')) input.checked = input.value === renderer;
      picker.querySelector('p').textContent = renderer === 'chromium'
        ? '保留网页样式。“目录”默认关闭，开启后在正文前增加可点击目录页；阅读器侧栏始终提供标题书签。'
        : '使用 Pandoc 重新排版。适用于未在页面中加载的消息及偏好打印版式的情况。';
    }
  }
  if (chrome.storage?.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.serverConnection) BASE = changes.serverConnection.newValue?.url || DEFAULT_BASE;
    if (area === 'local' && changes.pdfOptions) {
      renderer = changes.pdfOptions.newValue?.renderer === 'pandoc' ? 'pandoc' : 'chromium';
      updatePickers();
    }
  });
  function mountEnginePicker(container) {
    if (!container || container.dataset.localEnginePicker) return;
    container.dataset.localEnginePicker = 'true';
    const fieldset = document.createElement('fieldset');
    fieldset.style.cssText = 'border:1px solid #cbd5e1;border-radius:8px;padding:10px;margin:8px 0;font-size:13px;line-height:1.6';
    const legend = document.createElement('legend');
    legend.textContent = 'PDF 导出方式';
    fieldset.append(legend);
    for (const [value, text] of [['chromium', '网页原貌（推荐）'], ['pandoc', 'Pandoc 排版']]) {
      const label = document.createElement('label');
      label.style.cssText = 'display:inline-flex;align-items:center;gap:5px;margin-right:18px;cursor:pointer';
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'local-pdf-renderer'; input.value = value;
      input.addEventListener('change', async () => {
        if (!input.checked) return;
        renderer = value;
        updatePickers();
        const stored = await chrome.storage.local.get('pdfOptions');
        await chrome.storage.local.set({ pdfOptions: { ...stored.pdfOptions, renderer } });
      });
      label.append(input, document.createTextNode(text));
      fieldset.append(label);
    }
    const detail = document.createElement('p');
    detail.style.cssText = 'margin:6px 0 0;opacity:.75;font-size:12px';
    fieldset.append(detail);
    const connectionLink=document.createElement('a');
    connectionLink.href=chrome.runtime.getURL('local.html#server-config');connectionLink.target='_blank';connectionLink.rel='noopener';
    connectionLink.addEventListener('click',event=>{event.preventDefault();chrome.runtime.sendMessage({cmd:'open_service_settings'}).catch(error=>console.info(error.message));});
    connectionLink.textContent='配置服务器连接';fieldset.append(connectionLink);
    container.append(fieldset);
    pickers.add(fieldset);
    updatePickers();
  }

  async function bytesBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
  }

  async function upload(blob, name = "image.png") {
    if (!blob || blob.size > 16 * 1024 * 1024) throw new Error("Image must be smaller than 16 MiB");
    if (blob.type.split(";")[0] === "image/svg+xml") {
      // ChatGPT diagrams commonly use width="100%" with only a viewBox.
      // Give the standalone image intrinsic dimensions before decoding it.
      const xml = new DOMParser().parseFromString(await blob.text(), "image/svg+xml");
      const svg = xml.documentElement;
      if (svg.localName !== "svg" || xml.querySelector("parsererror")) throw new Error("Invalid SVG image");
      const box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
      const hasBox = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
      const length = attribute => {
        const value = svg.getAttribute(attribute) || "";
        return /^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(value) && parseFloat(value) > 0 ? parseFloat(value) : null;
      };
      let width = length("width");
      let height = length("height");
      if (!width) width = height && hasBox ? height * box[2] / box[3] : hasBox ? box[2] : 1024;
      if (!height) height = hasBox ? width * box[3] / box[2] : 768;
      svg.setAttribute("width", String(width));
      svg.setAttribute("height", String(height));
      blob = new Blob([new XMLSerializer().serializeToString(xml)], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const canvas = document.createElement("canvas");
        const scale = Math.min(2, 4096 / width, 4096 / height);
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("SVG conversion failed")), "image/png"));
        name = "image.png";
      } finally { URL.revokeObjectURL(url); }
    }
    const response = await chrome.runtime.sendMessage({ cmd: "local_request", payload: {
      path: "/api/file/u/v1", method: "POST", upload: { base64: await bytesBase64(blob), mime: blob.type, name }
    } });
    if (response.errcode) throw new Error(response.errmsg);
    const result = JSON.parse(response.text);
    if (response.status >= 400 || result.errcode) throw new Error(result.errmsg || "Local image upload failed");
    return result.url;
  }

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, globalThis.location?.href);
    if (url.origin === BASE || url.origin === DEFAULT_BASE) {
      await ready;
      let body = options.body;
      let uploadData;
      if (body instanceof FormData) {
        const file = body.get("file");
        const url = await upload(file, file.name);
        return Response.json({ errcode: 0, url });
      }
      if (body && typeof body !== "string") body = JSON.stringify(body);
      const response = await chrome.runtime.sendMessage({ cmd: "local_request", payload: { path: url.pathname + url.search, method: options.method || "GET", body, upload: uploadData } });
      if (response.errcode) throw new Error(response.errmsg);
      const content = response.base64 ? Uint8Array.from(atob(response.base64), char => char.charCodeAt(0)) : response.text;
      return new Response(content, { status: response.status, headers: { "Content-Type": response.mime } });
    }
    if (blocked(url)) return Response.json({ disabled: true });
    return originalFetch(input, options);
  };

  // Stop dormant bundled telemetry from falling back to XHR or sendBeacon.
  if (globalThis.XMLHttpRequest) {
    const proto = XMLHttpRequest.prototype;
    const open = proto.open;
    const send = proto.send;
    const setHeader = proto.setRequestHeader;
    proto.open = function(method, address, ...args) {
      this.localBlocked = blocked(new URL(address, location.href));
      if (!this.localBlocked) return open.call(this, method, address, ...args);
    };
    proto.setRequestHeader = function(...args) {
      if (!this.localBlocked) return setHeader.apply(this, args);
    };
    proto.send = function(...args) {
      if (!this.localBlocked) return send.apply(this, args);
      queueMicrotask(() => {
        for (const [key, value] of Object.entries({ status: 200, readyState: 4, responseText: "{}", response: "{}" })) Object.defineProperty(this, key, { value, configurable: true });
        for (const event of ["readystatechange", "load", "loadend"]) this.dispatchEvent(new Event(event));
      });
    };
  }
  if (globalThis.navigator?.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (address, data) => blocked(new URL(address, location.href)) ? true : beacon(address, data);
  }

  async function localize(markdown) {
    // Support Markdown inline images (including one level of URL parentheses).
    const pattern = /!\[((?:\\.|[^\]\\])*)\]\((<?(?:[^\s()<>]|\([^()]*\))+>?)(?:\s+"[^"]*")?\)/g;
    const replacements = new Map();
    for (const match of markdown.matchAll(pattern)) {
      const address = match[2].replace(/^<|>$/g, "");
      // data:image SVG is not directly supported by the PDF engine. It must
      // take the same decode -> PNG -> local upload route as other SVG images.
      if (address.startsWith(BASE + "/api/file/")) continue;
      if (replacements.has(address)) continue;
      try {
        if (blocked(new URL(address, location.href))) throw new Error("Original service image requests are disabled");
        const response = await originalFetch(address);
        if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
        replacements.set(address, await upload(await response.blob()));
      } catch (error) {
        console.info("Image could not be embedded:", error.message);
        replacements.set(address, "");
      }
    }
    return markdown.replace(pattern, (full, alt, address) => {
      const key = address.replace(/^<|>$/g, "");
      if (!replacements.has(key)) return full;
      return replacements.get(key) ? `![${alt}](${replacements.get(key)})` : `[图片无法读取：${alt || "image"}]`;
    });
  }

  function inlineSvgImages(root) {
    // Inline diagram SVGs otherwise disappear during HTML -> Markdown.
    // Math SVG fragments and control icons retain their existing converters.
    for (const svg of root.querySelectorAll("svg[viewBox], svg[data-d-component='svg']")) {
      if (svg.closest(".katex, button, [role='button']")) continue;
      const box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
      if (svg.getAttribute("data-d-component") !== "svg" && !(box.length === 4 && box[2] >= 64 && box[3] >= 64)) continue;
      const clone = svg.cloneNode(true);
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      const image = svg.ownerDocument.createElement("img");
      image.setAttribute("src", "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone)));
      image.setAttribute("alt", svg.getAttribute("aria-label") || "图示");
      svg.replaceWith(image);
    }
  }

  function messageRoots(selector = "div.group\\/turn-messages") {
    const existing = Array.from(document.querySelectorAll(selector));
    if (existing.length) return existing;
    // Current ChatGPT transcript DOM no longer has group/turn-messages or
    // section[data-turn-id]. Search units contain stable message IDs instead.
    const current = "[data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]";
    return Array.from(document.querySelectorAll(current)).filter(node => !node.parentElement?.closest(current));
  }

  function domTurnIdentity(node, index) {
    const section = node.closest("section[data-turn-id]");
    const key = node.getAttribute("data-chatgpt-search-unit-key") || "";
    const role = node.getAttribute("data-message-author-role") || section?.getAttribute("data-turn") ||
      (key.endsWith(":user") ? "user" : key.endsWith(":assistant") ? "assistant" : index % 2 === 0 ? "user" : "assistant");
    const id = section?.getAttribute("data-turn-id") || (node.getAttribute("data-chatgpt-search-message-ids") || "").trim().split(/\s+/)[0];
    return { turnId: id || `dom-turn-${index}`, role: role === "user" ? "user" : "assistant" };
  }

  function messageIds(conversation, turnId) {
    const mapping = conversation?.mapping;
    const ids = new Set([turnId]);
    if (!mapping) return [...ids].filter(Boolean);
    const chain = [];
    const visited = new Set();
    let key = conversation.current_node;
    while (key && mapping[key] && !visited.has(key)) {
      visited.add(key);
      chain.unshift(mapping[key]);
      key = mapping[key].parent;
    }
    const start = chain.findIndex(node => node.id === turnId || node.message?.id === turnId);
    if (start < 0) return [...ids].filter(Boolean);
    const user = chain[start].message?.author?.role === "user";
    for (let index = start; index < chain.length; index++) {
      const node = chain[index];
      const role = node.message?.author?.role;
      if (index > start && (user ? role && role !== "user" : role === "user")) break;
      ids.add(node.id);
      ids.add(node.message?.id);
    }
    return [...ids].filter(Boolean);
  }

  function renderedDiagramRecords(message) {
    const ids = new Set([message.turnId, ...(message.messageIds || [])].filter(Boolean));
    if (!ids.size) return [];
    const roots = document.querySelectorAll("[data-dil-message-id], [data-chatgpt-search-message-ids], [data-message-id], [data-turn-id]");
    const images = new Map();
    // Prefer the content-only renderer over an enclosing message with controls.
    const ordered = Array.from(roots).sort((a, b) => Number(!!b.getAttribute("data-dil-message-id")) - Number(!!a.getAttribute("data-dil-message-id")));
    for (const root of ordered) {
      const keys = ["data-dil-message-id", "data-chatgpt-search-message-ids", "data-message-id", "data-turn-id"]
        .flatMap(key => (root.getAttribute(key) || "").trim().split(/\s+/));
      if (!keys.some(id => ids.has(id))) continue;
      const blocks = Array.from(root.querySelectorAll("p, h1, h2, h3, h4, h5, h6, pre, table, figcaption, [data-d-component='caption'], img"));
      for (const img of root.querySelectorAll("img[data-d-component='svg'], img[src^='data:image/svg+xml']")) {
        const address = img.getAttribute("src");
        if (!address || images.has(address)) continue;
        const index = blocks.indexOf(img);
        const prose = nodes => nodes.map(node => (node.textContent || "").trim()).filter(Boolean);
        images.set(address, { address, before: index < 0 ? [] : prose(blocks.slice(0, index)).reverse().slice(0, 8),
          after: index < 0 ? [] : prose(blocks.slice(index + 1)).slice(0, 8) });
      }
    }
    return [...images.values()];
  }

  function renderedDiagrams(message) { return renderedDiagramRecords(message).map(record => record.address); }

  function insertDiagram(markdown, record) {
    if (markdown.includes(record.address)) return markdown;
    const normalize = text => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
    const offsets = [];
    let normalized = "";
    for (let offset = 0; offset < markdown.length;) {
      const char = String.fromCodePoint(markdown.codePointAt(offset));
      const value = normalize(char);
      normalized += value;
      for (let index = 0; index < value.length; index++) offsets.push(offset);
      offset += char.length;
    }
    function locate(texts, side, minimum = -1) {
      for (const text of texts) {
        const value = normalize(text);
        if (!value) continue;
        const sizes = [...new Set([48, 32, 24, 16, 12, 8, 6, value.length].filter(size => size <= value.length && (size >= 6 || size === value.length)))];
        for (const size of sizes) {
          const candidates = side === "before" ? [value.slice(-size), value.slice(0, size)] : [value.slice(0, size), value.slice(-size)];
          for (const candidate of candidates) {
            const found = [];
            let position = normalized.indexOf(candidate);
            while (position >= 0) {
              if (offsets[position] >= minimum) found.push(position);
              position = normalized.indexOf(candidate, position + 1);
            }
            // A preceding anchor disambiguates repeated short captions such
            // as “因此”. Without it, require a unique match in this message.
            if (found.length === 1 || (side === "after" && minimum >= 0 && found.length)) {
              const start = offsets[found[0]], end = offsets[found[0] + candidate.length - 1] + 1;
              return { start, end };
            }
          }
        }
      }
      return null;
    }
    const before = locate(record.before, "before");
    const after = locate(record.after, "after", before?.end ?? -1);
    let offset;
    if (after) {
      const breaks = [...markdown.slice(0, after.start).matchAll(/\n[\t ]*\n/g)];
      const last = breaks.at(-1);
      offset = last ? last.index + last[0].length : 0;
    } else if (before) {
      const next = /\n[\t ]*\n/.exec(markdown.slice(before.end));
      offset = next ? before.end + next.index : markdown.length;
    } else {
      console.info("Diagram text anchors unavailable; retaining image at message end");
      offset = markdown.length;
    }
    return markdown.slice(0, offset).trimEnd() + `\n\n![图示](${record.address})\n\n` + markdown.slice(offset).trimStart();
  }

  async function createPdf(payload) {
    await ready;
    const engine = payload.options?.renderer || renderer;
    if (engine === 'chromium') {
      if (!globalThis.LocalWebSnapshot) throw new Error('网页原貌模块尚未加载，请重新加载扩展并刷新聊天页。');
      const response = await fetch(BASE + '/health');
      const health = await response.json();
      if(!response.ok)throw new Error(health.errmsg || '无法连接导出服务，请检查服务器地址和访问令牌。');
      if (!health.engines?.chromium) throw new Error('所连接的服务版本过旧，请更新服务器后重试。');
      const webDocument = await LocalWebSnapshot.capture(payload);
      const result = await chrome.runtime.sendMessage({ cmd: 'pdf', payload: { cmd: 'create', payload: { ...payload, engine, webDocument } } });
      if (result.jobId && chrome.storage?.local) await chrome.storage.local.set({ lastWebPdfJob: { jobId: result.jobId, htmlUrl: result.htmlUrl, createdAt: Date.now() } });
      return result;
    }
    const messages = [];
    for (const message of payload.messages) {
      let markdown = message.markdown;
      // API fallbackMarkdown omits rendered DIL diagrams. Recover only images
      // belonging to this selected turn, never all images from the page.
      if (payload.sourceMode !== "dom") {
        for (const record of renderedDiagramRecords(message)) markdown = insertDiagram(markdown, record);
      }
      messages.push({ ...message, markdown: await localize(markdown) });
    }
    const localMarkdown = (payload.title ? `# ${payload.title}\n\n` : "") + messages.map(message => `## ${message.heading || message.role}\n\n${message.markdown}`).join("\n\n");
    return chrome.runtime.sendMessage({ cmd: "pdf", payload: { cmd: "create", payload: { ...payload, messages, localMarkdown } } });
  }

  globalThis.LocalExporter = { ready, createPdf, upload, inlineSvgImages, messageRoots, domTurnIdentity, messageIds, renderedDiagrams, insertDiagram, mountEnginePicker,
    usesWebRenderer: () => renderer === 'chromium',
    lastRenderedTurnId: () => { const roots = messageRoots(); return roots.length ? domTurnIdentity(roots.at(-1), roots.length - 1).turnId : null; } };
})();
