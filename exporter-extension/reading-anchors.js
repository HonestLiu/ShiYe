// TextQuote + TextPosition anchors; source nodes and their listeners are preserved.
(() => {
  const excluded =
    'script,style,noscript,template,input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-shiye-page-ui],[data-shiye-reading-ui],[data-shiye-note-appendix],[data-reader-ui],[hidden],.sr-only,svg';
  function index(doc) {
    const nodes = [],
      walker = doc.createTreeWalker(doc.body, 4);
    let text = '';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest(excluded)) continue;
      if (text.length + node.length > 10000000) throw Error('页面文字过长，暂不能定位标注');
      nodes.push({ node, start: text.length, end: text.length + node.length });
      text += node.data;
    }
    return { doc, nodes, text, positions: new Map(nodes.map((n, i) => [n.node, i])) };
  }
  function rangeAt(idx, start, end) {
    const a = idx.nodes.find((n) => n.end > start),
      b = idx.nodes.find((n) => n.end >= end && n.start < end);
    if (!a || !b || end <= start) return null;
    const r = idx.doc.createRange();
    r.setStart(a.node, start - a.start);
    r.setEnd(b.node, end - b.start);
    return r;
  }
  function capture(doc, selection = doc.defaultView.getSelection()) {
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const r = selection.getRangeAt(0);
    if (
      !doc.body.contains(r.commonAncestorContainer) ||
      r.startContainer.parentElement?.closest(excluded) ||
      r.endContainer.parentElement?.closest(excluded)
    )
      return null;
    const idx = index(doc),
      parts = [];
    for (const n of idx.nodes) {
      if (!r.intersectsNode(n.node)) continue;
      const start = n.node === r.startContainer ? r.startOffset : 0,
        end = n.node === r.endContainer ? r.endOffset : n.node.length;
      if (end > start) parts.push({ start: n.start + start, end: n.start + end });
    }
    if (!parts.length) return null;
    const start = parts[0].start,
      end = parts.at(-1).end,
      exact = idx.text.slice(start, end);
    if (!exact.trim() || exact.length > 12000) return null;
    return {
      exact,
      display: selection.toString().trim().slice(0, 12000),
      start,
      end,
      prefix: idx.text.slice(Math.max(0, start - 64), start),
      suffix: idx.text.slice(end, end + 64)
    };
  }
  function locate(idx, s) {
    if (!s?.exact) return null;
    const candidates = [];
    let at = -1;
    while ((at = idx.text.indexOf(s.exact, at + 1)) !== -1) {
      const prefix = idx.text.slice(Math.max(0, at - s.prefix.length), at),
        suffix = idx.text.slice(at + s.exact.length, at + s.exact.length + s.suffix.length);
      const score =
        (s.prefix && prefix === s.prefix ? 2 : 0) +
        (s.suffix && suffix === s.suffix ? 2 : 0) +
        (at === s.start ? 1 : 0);
      candidates.push({ at, score });
      if (candidates.length > 500) return null;
    }
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates.length || (candidates.length > 1 && candidates[0].score === candidates[1].score))
      return null;
    const best = candidates[0];
    if (candidates.length > 1 && best.score < 2) return null;
    return rangeAt(idx, best.at, best.at + s.exact.length);
  }
  function clear(doc) {
    for (const n of doc.querySelectorAll('mark[data-shiye-highlight]')) {
      const p = n.parentNode;
      n.replaceWith(...n.childNodes);
      p?.normalize();
    }
  }
  function paint(doc, record, { visible = true } = {}) {
    clear(doc);
    const missing = [],
      ranges = new Map();
    if (!visible || !record.annotations.length) return { missing, ranges };
    const idx = index(doc),
      parts = new Map();
    for (const a of record.annotations) {
      const r = locate(idx, a.selector);
      if (!r) {
        missing.push(a.id);
        continue;
      }
      ranges.set(a.id, r);
      const first = idx.positions.get(r.startContainer),
        last = idx.positions.get(r.endContainer);
      for (let i = first; i <= last; i++) {
        const n = idx.nodes[i];
        const start = r.startContainer === n.node ? r.startOffset : 0,
          end = r.endContainer === n.node ? r.endOffset : n.node.length;
        if (end <= start) continue;
        if (!parts.has(n.node)) parts.set(n.node, []);
        parts.get(n.node).push({ start, end, a });
      }
    }
    // Segment overlaps once per text node instead of nesting or replacing markup.
    for (const [node, list] of parts) {
      const cuts = [...new Set([0, node.length, ...list.flatMap((p) => [p.start, p.end])])].sort(
          (a, b) => a - b
        ),
        frag = doc.createDocumentFragment();
      for (let i = 0; i < cuts.length - 1; i++) {
        const start = cuts[i],
          end = cuts[i + 1],
          marks = list
            .filter((p) => p.start <= start && p.end >= end)
            .sort((a, b) => b.a.updatedAt - a.a.updatedAt);
        if (!marks.length) frag.append(doc.createTextNode(node.data.slice(start, end)));
        else {
          const m = doc.createElement('mark');
          m.style.setProperty('all', 'unset', 'important');
          m.dataset.shiyeHighlight = marks.map((p) => p.a.id).join(' ');
          m.style.setProperty('background-color', ShiyeReading.colors[marks[0].a.color], 'important');
          m.style.setProperty('color', '#172b23', 'important');
          m.style.setProperty('box-decoration-break', 'clone');
          m.textContent = node.data.slice(start, end);
          frag.append(m);
        }
      }
      node.replaceWith(frag);
    }
    return { missing, ranges };
  }
  function go(doc, record, id) {
    const a = record.annotations.find((n) => n.id === id);
    if (!a) return false;
    const r = locate(index(doc), a.selector);
    if (!r) return false;
    const target = r.startContainer.parentElement;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }
  function appendNotes(doc, record) {
    doc.querySelectorAll('[data-shiye-note-appendix]').forEach((n) => n.remove());
    if (!record.note.text && !record.annotations.some((a) => a.note)) return;
    const aside = doc.createElement('aside');
    aside.dataset.shiyeNoteAppendix = '';
    aside.style.cssText =
      'margin:32px auto;padding:24px;border-top:1px solid #ccd8cd;font:15px/1.8 system-ui;white-space:pre-wrap;max-width:900px;color:#253b33;background:#fffdf8';
    const h = doc.createElement('h2');
    h.textContent = '阅读笔记';
    aside.append(h);
    if (record.note.text) {
      const p = doc.createElement('p');
      p.textContent = record.note.text;
      aside.append(p);
    }
    for (const a of record.annotations)
      if (a.note) {
        const q = doc.createElement('blockquote');
        q.textContent = a.selector.display || a.selector.exact;
        const p = doc.createElement('p');
        p.textContent = a.note;
        aside.append(q, p);
      }
    doc.body.append(aside);
  }
  function html(source, record, { notes = true } = {}) {
    if (!record) return source;
    record = ShiyeReading.validate(record);
    const doc = new DOMParser().parseFromString(source, 'text/html');
    paint(doc, record);
    if (notes) appendNotes(doc, record);
    return '<!doctype html>' + doc.documentElement.outerHTML;
  }
  globalThis.ShiyeAnchors = { index, capture, locate, paint, clear, go, html };
})();
