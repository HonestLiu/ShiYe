/* Runs inside the frozen Chromium document via DevTools, with page JS off. */
export function addHeadingNavigation({ toc = false } = {}) {
  // Remove only a previously generated catalogue, so repeated rendering is safe.
  document.querySelectorAll('[data-pdf-toc]').forEach(node => node.remove());
  const all = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],[data-d-component="title"]')];
  const counts = new Map();
  for (const node of document.querySelectorAll('[id]')) counts.set(node.id, (counts.get(node.id) || 0) + 1);
  const ids = new Set(counts.keys());
  const headings = [];
  const seen = new Set();
  for (const node of all) {
    if (seen.has(node)) continue;
    seen.add(node);
    const owner = node.closest('.pdf-message');
    const excluded = owner && ['Prompt', 'user'].includes(owner.getAttribute('data-role'));
    const style = getComputedStyle(node);
    if (excluded || node.closest('button,pre,code,.katex,[hidden],.sr-only,[data-pdf-toc]') || !node.getClientRects().length || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      // Hidden speaker labels must not become distracting PDF bookmarks.
      if (/^H[1-6]$/.test(node.tagName)) node.setAttribute('role', 'presentation');
      continue;
    }
    const copy = node.cloneNode(true);
    copy.querySelectorAll('.katex-mathml,script,style,button').forEach(child => child.remove());
    const title = (copy.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    const candidate = Number(node.tagName.match(/^H([1-6])$/)?.[1] || node.getAttribute('aria-level') || 2);
    const level = Number.isFinite(candidate) ? Math.max(1, Math.min(6, Math.floor(candidate))) : 2;
    let id = node.id;
    if (!id || counts.get(id) > 1) {
      let number = headings.length + 1;
      while (ids.has(`local-pdf-heading-${number}`)) number++;
      id = `local-pdf-heading-${number}`;
      node.id = id;
      ids.add(id);
    }
    if (!/^H[1-6]$/.test(node.tagName)) {
      node.setAttribute('role', 'heading');
      node.setAttribute('aria-level', String(level));
    }
    headings.push({ title, level, id });
  }
  if (!toc || !headings.length) return { headings: headings.length, tocEntries: 0 };
  const root = document.querySelector('.pdf-document') || document.body;
  const theme = getComputedStyle(document.body);
  const nav = document.createElement('nav');
  nav.setAttribute('data-pdf-toc', '');
  nav.setAttribute('aria-label', '目录');
  nav.style.cssText = 'break-after:page;margin:0 0 32px;padding:0;font:inherit;line-height:1.65';
  const title = document.createElement('div');
  title.textContent = '目录';
  title.style.cssText = 'font-size:26px;font-weight:700;line-height:1.4;margin:0 0 18px';
  nav.append(title);
  function list() {
    const node = document.createElement('ol');
    node.style.cssText = 'list-style:none;margin:0;padding:0 0 0 20px';
    return node;
  }
  const top = list();
  top.style.paddingLeft = '0';
  nav.append(top);
  const stack = [{ level: 0, item: null, list: top }];
  for (const heading of headings) {
    while (stack.length > 1 && stack.at(-1).level >= heading.level) stack.pop();
    const parent = stack.at(-1);
    if (!parent.list) { parent.list = list(); parent.item.append(parent.list); }
    const item = document.createElement('li');
    item.style.cssText = 'margin:7px 0;padding:0;break-inside:avoid';
    const link = document.createElement('a');
    link.href = '#' + encodeURIComponent(heading.id);
    link.textContent = heading.title;
    link.style.cssText = 'text-decoration:none;overflow-wrap:anywhere';
    link.style.color = theme.color;
    item.append(link);
    parent.list.append(item);
    stack.push({ level: heading.level, item, list: null });
  }
  root.prepend(nav);
  return { headings: headings.length, tocEntries: headings.length };
}
