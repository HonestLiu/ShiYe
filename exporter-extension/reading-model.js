// Local reading records. Shared by the extension and the desktop client.
(() => {
  const colors = { yellow: '#ffe89a', green: '#bde8c7', blue: '#bcdcff', pink: '#f7c9da', purple: '#dfcafa' };
  const underlineColors = { yellow: '#c78b08', green: '#318957', blue: '#3678c5', pink: '#c14e80', purple: '#8654bf' };
  function url(value) {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.href.length > 8000)
      throw Error('无效的网页地址');
    if (!/^#(?:\/|!)/.test(u.hash)) u.hash = '';
    return u.href;
  }
  const empty = (value) => ({
    version: 1,
    url: url(value),
    annotations: [],
    deleted: [],
    note: { text: '', updatedAt: 0, mutationId: '' },
    meta: { title: '', folder: '', tags: '', starred: false, read: false, updatedAt: 0, mutationId: '' }
  });
  const newer = (a, b) =>
    !b || a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.mutationId > b.mutationId);
  const text = (s, max) => {
    if (typeof s !== 'string' || s.length > max) throw Error('笔记或摘录内容过长');
    return s;
  };
  function stamp(x) {
    if (
      !x ||
      !Number.isSafeInteger(x.updatedAt) ||
      x.updatedAt < 0 ||
      x.updatedAt > Date.now() + 86400000 ||
      typeof x.mutationId !== 'string' ||
      x.mutationId.length > 80
    )
      throw Error('无效的笔记版本');
  }
  function validate(value, expected) {
    if (!value || value.version !== 1 || url(value.url) !== url(expected || value.url))
      throw Error('笔记来源不匹配');
    if (
      !Array.isArray(value.annotations) ||
      value.annotations.length > 500 ||
      !Array.isArray(value.deleted) ||
      value.deleted.length > 2000
    )
      throw Error('本页标注数量超限');
    const v = JSON.parse(JSON.stringify(value));
    v.url = url(v.url);
    const ids = new Set();
    for (const a of v.annotations) {
      stamp(a);
      if (
        !/^[a-zA-Z0-9-]{1,80}$/.test(a.id) ||
        typeof a.id !== 'string' ||
        ids.has(a.id) ||
        !Object.hasOwn(colors, a.color)
      )
        throw Error('无效的标注');
      ids.add(a.id);
      text(a.note, 20000);
      text(a.selector?.exact, 12000);
      if (!a.selector.exact.trim()) throw Error('标注正文不能为空');
      if (a.selector.display !== undefined) text(a.selector.display, 12000);
      text(a.selector.prefix, 100);
      text(a.selector.suffix, 100);
      for (const n of ['start', 'end'])
        if (!Number.isSafeInteger(a.selector[n]) || a.selector[n] < 0 || a.selector[n] > 10000000)
          throw Error('无效的标注位置');
      if (a.selector.end - a.selector.start !== a.selector.exact.length) throw Error('无效的标注范围');
    }
    for (const d of v.deleted) {
      stamp(d);
      if (typeof d.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(d.id)) throw Error('无效的删除记录');
    }
    stamp(v.note);
    text(v.note.text, 100000);
    stamp(v.meta);
    for (const [k, max] of [
      ['title', 300],
      ['folder', 100],
      ['tags', 500]
    ])
      text(v.meta[k], max);
    if (typeof v.meta.starred !== 'boolean' || typeof v.meta.read !== 'boolean')
      throw Error('无效的收藏状态');
    if (new TextEncoder().encode(JSON.stringify(v)).length > 512 * 1024)
      throw Error('本页笔记超过512KiB，请先导出整理');
    return v;
  }
  function merge(left, right) {
    left = validate(left);
    right = validate(right, left.url);
    const out = empty(left.url),
      entries = new Map(),
      deleted = new Map();
    for (const d of [...left.deleted, ...right.deleted])
      if (newer(d, deleted.get(d.id))) deleted.set(d.id, d);
    for (const a of [...left.annotations, ...right.annotations])
      if (newer(a, entries.get(a.id))) entries.set(a.id, a);
    out.deleted = [...deleted.values()].sort((a, b) => a.id.localeCompare(b.id));
    out.annotations = [...entries.values()]
      .filter((a) => !deleted.has(a.id) || newer(a, deleted.get(a.id)))
      .sort((a, b) => a.selector.start - b.selector.start || a.id.localeCompare(b.id));
    out.note = newer(right.note, left.note) ? right.note : left.note;
    out.meta = newer(right.meta, left.meta) ? right.meta : left.meta;
    return validate(out);
  }
  function mutate(record, op) {
    const out = validate(record);
    const same = (a, b) => a && b && a.updatedAt === b.updatedAt && a.mutationId === b.mutationId;
    const conflict = () => {
      throw Error('此笔记已在另一处更新，当前草稿仍保留；请复制草稿后重新打开记录');
    };
    if (op.expected) {
      const current =
        op.kind === 'note'
          ? out.note
          : op.kind === 'meta'
            ? out.meta
            : out.annotations.find((a) => a.id === (op.annotation?.id || op.id));
      if (!same(current, op.expected)) conflict();
    }
    if (
      op.base &&
      ((!same(out.note, op.base.note) && out.note.text !== op.base.note.text) ||
        ['folder', 'tags', 'starred', 'read'].some((k) => out.meta[k] !== op.base.meta[k]))
    )
      conflict();
    const latest = Math.max(
      out.note.updatedAt,
      out.meta.updatedAt,
      ...out.annotations.map((a) => a.updatedAt),
      ...out.deleted.map((a) => a.updatedAt)
    ),
      s = {
        updatedAt: Math.max(Date.now(), latest + 1),
        mutationId:
          crypto.randomUUID?.() ||
          Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join(
            ''
          )
      };
    if (op.kind === 'organize') {
      out.note = { text: op.text, ...s };
      out.meta = { ...out.meta, ...op.patch, ...s };
    } else if (op.kind === 'upsert') {
      const a = { ...op.annotation, ...s };
      out.annotations = out.annotations.filter((n) => n.id !== a.id);
      out.annotations.push(a);
    } else if (op.kind === 'delete') {
      out.annotations = out.annotations.filter((n) => n.id !== op.id);
      out.deleted = out.deleted.filter((n) => n.id !== op.id);
      out.deleted.push({ id: op.id, ...s });
    } else if (op.kind === 'note') out.note = { text: op.text, ...s };
    else if (op.kind === 'meta') out.meta = { ...out.meta, ...op.patch, ...s };
    else throw Error('无效的笔记操作');
    return validate(out);
  }
  function markdown(record) {
    const v = validate(record),
      lines = ['# ' + (v.meta.title || '阅读笔记'), '', v.url, ''];
    if (v.meta.folder) lines.push('收藏夹：' + v.meta.folder, '');
    if (v.meta.tags) lines.push('标签：' + v.meta.tags, '');
    if (v.note.text) lines.push('## 阅读笔记', '', v.note.text, '');
    for (const a of v.annotations) {
      lines.push('> ' + (a.selector.display || a.selector.exact).replace(/\r?\n/g, '\n> '), '');
      if (a.note) lines.push(a.note, '');
    }
    return lines.join('\n');
  }
  function filename(title, extension) {
    const d = new Date(),
      pad = (n) => String(n).padStart(2, '0'),
      stamp =
        d.getFullYear() +
        pad(d.getMonth() + 1) +
        pad(d.getDate()) +
        '-' +
        pad(d.getHours()) +
        pad(d.getMinutes()) +
        pad(d.getSeconds());
    return (
      String(title || '阅读笔记')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
        .replace(/^\.+/, '_')
        .slice(0, 100) +
      '_' +
      stamp +
      '.' +
      extension
    );
  }
  globalThis.ShiyeReading = { colors, underlineColors, url, empty, validate, merge, mutate, markdown, filename };
})();
