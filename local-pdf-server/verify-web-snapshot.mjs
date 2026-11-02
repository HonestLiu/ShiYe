/* Verify freezing logic against a small DOM boundary; no browser launch here. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
class Node {
  constructor(tag, text = '', attributes = {}, style = {}) {
    this.tagName = tag.toUpperCase(); this.text = text; this.attrs = { ...attributes }; this.children = [];
    this.parentElement = null; this.styleValues = style; this.ownerDocument = doc;
    this.classList = { add: value => this.attrs.class = ((this.attrs.class || '') + ' ' + value).trim() };
  }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  get className() { return this.attrs.class || ''; }
  set className(value) { this.attrs.class = value; }
  get currentSrc() { return this.attrs.src; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  matches(selector) {
    return selector.split(',').some(text => {
      text = text.trim();
      if (text.startsWith('.')) return (this.attrs.class || '').split(/\s+/).includes(text.slice(1));
      if (text.startsWith('[')) return text.slice(1, -1) in this.attrs;
      if (text === 'section[data-turn-id]') return this.tagName === 'SECTION' && 'data-turn-id' in this.attrs;
      return text.toUpperCase() === this.tagName;
    });
  }
  closest(selector) { let node = this; while (node) { if (node.matches(selector)) return node; node = node.parentElement; } return null; }
  querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); return selector === '*' ? all : all.filter(node => node.matches(selector)); }
  cloneNode() { const node = new Node(this.tagName, this.text, this.attrs, this.styleValues); node.append(...this.children.map(child => child.cloneNode(true))); return node; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
  replaceWith(node) { const parent = this.parentElement; if (parent) { const index = parent.children.indexOf(this); parent.children[index] = node; node.parentElement = parent; } }
  getBoundingClientRect() { return { width: this.styleValues.width ? parseFloat(this.styleValues.width) : 760 }; }
  get outerHTML() { return `<${this.tagName.toLowerCase()} ${this.attributes.map(({name,value}) => `${name}="${escape(value)}"`).join(' ')}>${escape(this.text)}${this.children.map(node => node.outerHTML).join('')}</${this.tagName.toLowerCase()}>`; }
}
const doc = {
  baseURI: 'https://chatgpt.com/c/example', title: 'Actual appearance',
  documentElement: { lang: 'zh-CN', dataset: { theme: 'light' } },
  defaultView: { getComputedStyle: (node, pseudo) => {
    const values = pseudo ? { content: 'none' } : { display: 'block', color: 'rgb(13, 13, 13)', 'font-family': 'KaTeX_Main, sans-serif', 'font-size': '16px', 'line-height': '28px', 'background-color': 'rgb(255, 255, 255)', ...node.styleValues };
    return { getPropertyValue: key => values[key] || '', backgroundColor: values['background-color'], color: values.color, fontFamily: values['font-family'] };
  } },
  styleSheets: [{ href: 'https://cdn.oaistatic.com/style.css', cssRules: [{ cssRules: [{ type: 5, cssText: '@font-face{font-family:KaTeX_Main;src:url("font.woff2")}' }] }] }],
  createElement: tag => new Node(tag)
};
doc.body = new Node('body');
const source = new Node('div', '', { 'data-chatgpt-search-message-ids': 'chosen', style: 'font-size:99px' }, { width: '760px' });
const paragraph = new Node('p', '图前内容', { onclick: 'steal()' });
const image = new Node('img', '', { src: 'blob:https://chatgpt.com/graph' });
const after = new Node('p', '图后内容', {}, { color: 'rgb(42, 87, 180)' });
const formula = new Node('span', 'x²', { class: 'katex-html' }, { position: 'relative', 'font-size': '19px' });
const duplicate = new Node('span', 'duplicated MathML', { class: 'katex-mathml' });
const button = new Node('button', 'copy');
const script = new Node('script', 'steal()');
source.append(paragraph, image, after, formula, duplicate, button, script);
const other = new Node('div', 'unselected content', { 'data-chatgpt-search-message-ids': 'other' }, {width:'400px'});
const fetched = [];
const context = vm.createContext({ console, URL, Blob, Response, Uint8Array, btoa, atob, setTimeout,
  document: doc, LocalExporter: { messageRoots: () => [source, other] },
  fetch: async address => { fetched.push(address); return new Response('resource-bytes', { headers: {'Content-Type': address.endsWith('woff2') ? 'font/woff2' : 'image/png'} }); }
});
vm.runInContext(fs.readFileSync(new URL('web-snapshot.js', import.meta.url), 'utf8'), context);
const snapshot = await context.LocalWebSnapshot.capture({title:'自定义标题',messages:[{turnId:'chosen',role:'Response'}],options:{}});
assert.equal(snapshot.width, 760);
assert(snapshot.html.includes('自定义标题'));
assert(snapshot.html.indexOf('图前内容') < snapshot.html.indexOf('data:image/png;base64,'));
assert(snapshot.html.indexOf('data:image/png;base64,') < snapshot.html.indexOf('图后内容'));
assert(snapshot.html.includes('font-size:19px') && snapshot.html.includes('rgb(42, 87, 180)'));
assert(snapshot.html.includes('data:font/woff2;base64,'));
assert(snapshot.html.includes('x²') && !snapshot.html.includes('duplicated MathML'));
assert(!snapshot.html.includes('onclick') && !snapshot.html.includes('<script') && !snapshot.html.includes('steal()'));
assert(!snapshot.html.includes('unselected content') && !snapshot.html.includes('blob:https:'));
assert(!snapshot.html.includes('https://cdn.oaistatic.com/font.woff2'));
assert.equal(fetched.length, 2);
await assert.rejects(context.LocalWebSnapshot.capture({messages:[{turnId:'not-loaded'}],options:{}}), /尚未在网页中加载/);
console.log('PASS: selected DOM only, original image position, resolved/deduplicated typography/colors, embedded blob images and nested webfonts, stripped controls/scripts/events, missing-rendered-message error. Browser startup is tested separately.');
