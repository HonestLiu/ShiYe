// Parse the user's actual saved DOM, run the shipped bridge, rasterize its SVGs
// with AppKit, then generate a PDF with the actual local backend. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const toolkit = process.env.LOCAL_TEST_NODE_MODULES || path.join(os.homedir(), '.local/lib/node_modules/rea-agents/node_modules');
const { parse } = await import(pathToFileURL(require.resolve('parse5', { paths: [toolkit] })));
const xml = require(require.resolve('@xmldom/xmldom', { paths: [toolkit] }));
const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: node verify-saved-html.mjs /absolute/path/to/saved.html');
const tree = parse(fs.readFileSync(sourcePath, 'utf8'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-chat-html-'));
const uploaded = new Map(), draws = [];
const wrappers = new WeakMap();
function matches(node, selector) {
  if (!node.tagName) return false;
  return selector.split(',').some(part => {
    part = part.trim();
    const tag = part.match(/^[\w-]+/);
    if (tag && node.tagName !== tag[0]) return false;
    const attrs = new Map((node.attrs || []).map(attribute => [attribute.name, attribute.value]));
    const attributes = [...part.matchAll(/\[([\w-]+)(?:(\^?=)['"]([^'"]*)['"])?\]/g)];
    for (const [, key, operator, value] of attributes) {
      if (!attrs.has(key) || (operator === '=' && attrs.get(key) !== value) || (operator === '^=' && !attrs.get(key).startsWith(value))) return false;
    }
    const remaining = part.replace(/\[[^\]]*\]/g, '').replace(/^[\w-]+/, '');
    if (remaining.startsWith('.')) return attrs.get('class')?.split(/\s+/).includes(remaining.slice(1).replaceAll('\\', '')) || false;
    assert.equal(remaining, '', 'Unsupported test selector: ' + part);
    return true;
  });
}
function descendants(node) { return (node.childNodes || []).flatMap(child => [child, ...descendants(child)]); }
function wrap(node) {
  if (!node) return null;
  if (wrappers.has(node)) return wrappers.get(node);
  const value = {
    raw: node,
    getAttribute: key => (node.attrs || []).find(attribute => attribute.name === key)?.value ?? null,
    get textContent() { return [node, ...descendants(node)].filter(child => child.nodeName === '#text').map(child => child.value).join(''); },
    querySelectorAll: selector => descendants(node).filter(child => matches(child, selector)).map(wrap),
    closest(selector) { let candidate = node; while (candidate) { if (matches(candidate, selector)) return wrap(candidate); candidate = candidate.parentNode; } return null; },
    get parentElement() { return node.parentNode?.tagName ? wrap(node.parentNode) : null; }
  };
  wrappers.set(node, value);
  return value;
}
const document = wrap(tree);
class DOMParser {
  parseFromString(text, type) {
    const doc = new xml.DOMParser().parseFromString(text, type);
    doc.querySelector = selector => doc.getElementsByTagName(selector)[0] || null;
    return doc;
  }
}
let decoded = '';
class Image { async decode() { decoded = await (await fetch(this.src)).text(); } }
document.createElement = tag => {
  assert.equal(tag, 'canvas');
  return { width: 0, height: 0,
    getContext() { return { drawImage: () => {} }; },
    toBlob(callback) {
      const index = draws.length;
      const svg = path.join(temporary, `image-${index}.svg`), png = path.join(temporary, `image-${index}.png`);
      fs.writeFileSync(svg, decoded);
      execFileSync('/usr/bin/swift', ['-module-cache-path', '/tmp/local-pdf-swift-cache', path.join(here, 'tests/render-svg.swift'), svg, png, String(this.width), String(this.height)], { env: { ...process.env, CLANG_MODULE_CACHE_PATH: '/tmp/local-pdf-clang-cache' }, stdio: 'pipe' });
      draws.push({ width: this.width, height: this.height, file: png });
      callback(new Blob([fs.readFileSync(png)], { type: 'image/png' }));
    }
  };
};
let lastPayload;
const context = vm.createContext({ console, URL, Request, Response, Blob, FormData, Uint8Array, atob, btoa,
  DOMParser, XMLSerializer: xml.XMLSerializer, Image, document, location: { href: pathToFileURL(sourcePath).href },
  fetch: async address => { assert(String(address).startsWith('data:image/'), 'Unexpected network request'); return fetch(address); },
  chrome: { storage: { local: { get: async () => ({pdfOptions:{renderer:'pandoc'}}) } }, runtime: { sendMessage: async message => {
    if (message.cmd === 'local_ready') return { errcode: 0 };
    if (message.cmd === 'pdf') { lastPayload = message.payload.payload; return { errcode: 0, jobId: 'verified' }; }
    const image = message.payload.upload;
    const bytes = Buffer.from(image.base64, 'base64');
    const hash = createHash('sha256').update(bytes).digest('hex');
    uploaded.set(hash + '.png', { ...image, hash });
    return { status: 200, text: JSON.stringify({ errcode: 0, url: `http://127.0.0.1:8765/api/file/${hash}.png` }) };
  } } }
});
vm.runInContext(fs.readFileSync(path.join(here, '../local-extension/bridge.js'), 'utf8'), context);
const bridge = context.LocalExporter;
function toMarkdown(node) {
  if (node.nodeName === '#text') return node.value;
  const attrs = new Map((node.attrs || []).map(attribute => [attribute.name, attribute.value]));
  if (['script', 'style', 'button', 'img', 'svg'].includes(node.tagName) || attrs.get('class')?.split(/\s+/).includes('sr-only')) return '';
  if (attrs.get('class')?.split(/\s+/).includes('katex')) {
    const annotation = descendants(node).find(child => child.tagName === 'annotation');
    const math = annotation ? (annotation.childNodes || []).map(child => child.value || '').join('') : '';
    return math ? '$' + math + '$' : '';
  }
  const text = (node.childNodes || []).map(toMarkdown).join('');
  return ['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4'].includes(node.tagName) ? '\n\n' + text.trim() + '\n\n' : text;
}
try {
  const roots = Array.from(bridge.messageRoots());
  assert.equal(roots.length, 4, 'Expected four actual transcript message roots');
  const messages = roots.map((root, index) => {
    const identity = bridge.domTurnIdentity(root, index);
    return { ...identity, role: identity.role === 'user' ? 'Prompt' : 'Response', heading: identity.role === 'user' ? '用户' : '助手', markdown: toMarkdown(root.raw).replace(/\n{3,}/g, '\n\n').trim() || '附件图片（保存文件中仅有 blob 引用）' };
  });
  const assistants = messages.filter(message => message.role === 'Response');
  assert.deepEqual(assistants.map(message => bridge.renderedDiagrams(message).length), [1, 1]);
  assert(messages.filter(message => message.role === 'Prompt').every(message => !bridge.renderedDiagrams(message).length));
  // Assistant export turn IDs can be analysis node IDs; recover its final DIL ID.
  const mapping = { analysis: { id: 'analysis', parent: null, message: { id: 'analysis', author: { role: 'assistant' } } }, final: { id: 'final', parent: 'analysis', message: { id: assistants[0].turnId, author: { role: 'assistant' } } }, next: { id: 'next', parent: 'final', message: { id: 'next-user', author: { role: 'user' } } } };
  const ids = bridge.messageIds({ mapping, current_node: 'next' }, 'analysis');
  assert(ids.includes(assistants[0].turnId) && !ids.includes('next-user'));
  await bridge.createPdf({ title: '所选单条回答', sourceMode: 'api', messages: [{ ...assistants[0], turnId: 'analysis', messageIds: ids }], options: {} });
  assert.equal((lastPayload.messages[0].markdown.match(/!\[/g) || []).length, 1);
  assert(!lastPayload.messages[0].markdown.includes(bridge.renderedDiagrams(assistants[1])[0]));
  await bridge.createPdf({ title: '微分方程与体积求解（实际网页验证）', sourceMode: 'api', messages, options: { removeBrand: true, fontSize: 100 } });
  assert.equal(lastPayload.messages.reduce((count, message) => count + (message.markdown.match(/!\[/g) || []).length, 0), 2);
  assert.equal(uploaded.size, 2, 'Both actual diagrams must be converted to distinct PNGs');
  const responses = lastPayload.messages.filter(message => message.role === 'Response');
  if (process.env.DEBUG_DIAGRAM_POSITIONS) console.log(responses.map(message => ({ image: message.markdown.indexOf('!['), context: message.markdown.slice(Math.max(0, message.markdown.indexOf('![') - 160), message.markdown.indexOf('![') + 260), steps: [...message.markdown.matchAll(/第二步[^\n]*/g)].map(match => [match.index, match[0]]) })));
  assert(responses[0].markdown.indexOf('![') < responses[0].markdown.lastIndexOf('第二步：代入'), 'Volume diagram must precede the next step');
  assert(responses[0].markdown.indexOf('![') < responses[0].markdown.indexOf('示意图：蓝色区域'), 'Volume diagram must precede its original caption');
  assert(responses[0].markdown.indexOf('![') > responses[0].markdown.indexOf('为什么要平方'), 'Volume diagram must follow the radius explanation');
  assert(responses[1].markdown.indexOf('![') > responses[1].markdown.indexOf('所以函数的正负完全由'), 'Area diagram must follow sign explanation');
  assert(responses[1].markdown.indexOf('![') < responses[1].markdown.indexOf('因此'), 'Area diagram must precede the integral setup');
  assert(responses[1].markdown.indexOf('![') < responses[1].markdown.indexOf('示意图：曲线交替'), 'Area diagram must precede its original caption');
  const bundle = path.join(temporary, 'payload.json');
  fs.writeFileSync(bundle, JSON.stringify({ payload: lastPayload, uploaded: [...uploaded.values()] }));
  execFileSync('python3', ['-c', `
import os,sys,json,tempfile,uuid,re,base64,shutil
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='actual-html-pdf-') as data:
 os.environ['LOCAL_EXPORT_DATA_DIR']=data
 sys.path.insert(0,sys.argv[1]);import server,local_images
 bundle=json.loads(Path(sys.argv[2]).read_text())
 for image in bundle['uploaded']:
  name,_=local_images.store(base64.b64decode(image['base64']));assert name==image['hash']+'.png'
 job=uuid.uuid4().hex;folder=Path(data)/'jobs'/job;folder.mkdir(parents=True)
 server.JOBS[job]={'directory':folder,'status':'queued','created':0}
 server.generate(job,bundle['payload']);assert server.JOBS[job]['status']=='done',server.JOBS[job]
 pdf=(folder/'document.pdf').read_bytes();assert len(re.findall(rb'/Subtype\\s*/Image',pdf))>=2
 shutil.copy2(folder/'document.pdf',sys.argv[3]);server.POOL.shutdown(wait=True)
 print('PASS: actual saved HTML -> selected-message SVG recovery in original prose order -> real raster -> local upload -> real PDF; two images embedded')
`, here, bundle, path.join(here, '../output/pdf/actual-chat-diagrams.pdf')], { stdio: 'inherit' });
  console.log(JSON.stringify({ transcriptMessages: messages.length, diagrams: uploaded.size, rasterSizes: draws.map(({width,height}) => [width,height]), output: 'output/pdf/actual-chat-diagrams.pdf' }));
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
