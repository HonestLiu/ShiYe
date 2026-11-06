// Shared trusted UI: all user text is assigned through textContent/value.
(() => {
  function mount({
    container,
    record,
    mutate,
    status = () => {},
    locate = () => false,
    sync,
    clip,
    exportNotes,
    changed = () => {}
  }) {
    const node = document.createElement('section');
    node.className = 'shiye-notes';
    node.innerHTML =
      '<div class="notes-meta"><label>收藏夹<input data-field="folder" maxlength="100" placeholder="例如：学习 / 待读"></label><label>标签（逗号分隔）<input data-field="tags" maxlength="500" placeholder="计组, 参考资料"></label><div class="notes-checks"><label><input type="checkbox" data-field="starred">星标</label><label><input type="checkbox" data-field="read">已读</label></div></div><label class="notes-label">整页阅读笔记<textarea data-page-note rows="4" maxlength="100000" placeholder="记下自己的理解、疑问或下一步…"></textarea></label><div class="notes-actions"><button data-save class="primary">保存笔记与整理</button><button data-sync>同步客户端</button><button data-export>导出笔记</button></div><p class="notes-help">笔记保存在本机。定位失败时保留摘录，不强行标到其他段落。</p><div class="notes-list-head"><strong>高亮与批注 <span data-count></span></strong><label><input type="checkbox" data-visible checked>显示高亮</label></div><div data-marks></div><p data-empty>选中网页文字后，可高亮、添加批注或收藏选区。</p>';
    container.append(node);
    const $ = (s) => node.querySelector(s);
    let value = record,
      busy = false,
      visible = true,
      dirty = false,
      draftBase = null,
      editors = new Map();
    function values() {
      for (const k of ['folder', 'tags']) $('[data-field=' + k + ']').value = value.meta[k];
      for (const k of ['starred', 'read']) $('[data-field=' + k + ']').checked = value.meta[k];
      $('[data-page-note]').value = value.note.text;
      dirty = false;
      draftBase = null;
    }
    const controls = () => [...node.querySelectorAll('button')];
    async function run(fn) {
      if (busy) return;
      busy = true;
      controls().forEach((b) => (b.disabled = true));
      try {
        await fn();
      } catch (e) {
        status(e.message);
      } finally {
        busy = false;
        controls().forEach((b) => (b.disabled = false));
      }
    }
    function set(next, { reset = false } = {}) {
      value = ShiyeReading.validate(next);
      if (reset || !dirty) values();
      render();
      changed(value, { visible });
    }
    async function update(op) {
      const next = await mutate(op);
      set(next);
      return next;
    }
    function render() {
      const focus = node.getRootNode().activeElement,
        active = focus?.closest?.('[data-mark-card]');
      const focusedId = active?.dataset.markCard;
      const drafts = new Map(
        [...editors].filter(([, v]) => v.dirty).map(([id, v]) => [id, { text: v.input.value, base: v.base }])
      );
      editors.clear();
      $('[data-count]').textContent = value.annotations.length;
      $('[data-empty]').hidden = !!value.annotations.length;
      const list = $('[data-marks]');
      list.replaceChildren();
      for (const a of value.annotations) {
        const card = document.createElement('article');
        card.dataset.markCard = a.id;
        card.className = 'notes-card';
        const quote = document.createElement('button');
        quote.className = 'notes-quote';
        quote.textContent = a.selector.display || a.selector.exact;
        quote.style.borderLeftColor = ShiyeReading.colors[a.color];
        quote.title = '定位原文';
        quote.onclick = () => {
          if (!locate(a.id)) status('原文位置已变化，仍保留此摘录与笔记');
        };
        card.append(quote);
        const colors = document.createElement('div');
        colors.className = 'notes-colors';
        colors.setAttribute('role', 'group');
        colors.setAttribute('aria-label', '标注颜色');
        for (const [color, label] of [
          ['yellow', '黄色'],
          ['green', '绿色'],
          ['blue', '蓝色'],
          ['pink', '粉色'],
          ['purple', '紫色']
        ]) {
          const b = document.createElement('button');
          b.className = 'notes-color';
          b.style.backgroundColor = ShiyeReading.colors[color];
          b.setAttribute('aria-label', label);
          b.setAttribute('aria-pressed', String(a.color === color));
          b.onclick = () => run(() => update({ kind: 'upsert', annotation: { ...a, color }, expected: a }));
          colors.append(b);
        }
        card.append(colors);
        const input = document.createElement('textarea');
        input.rows = 2;
        input.maxLength = 20000;
        input.setAttribute('aria-label', '段落批注');
        input.placeholder = '添加对这段话的思考…';
        input.value = drafts.has(a.id) ? drafts.get(a.id).text : a.note;
        const state = { input, dirty: drafts.has(a.id), base: drafts.get(a.id)?.base || a };
        editors.set(a.id, state);
        input.oninput = () => (state.dirty = true);
        card.append(input);
        const actions = document.createElement('div');
        actions.className = 'notes-actions';
        const save = document.createElement('button');
        save.textContent = '保存批注';
        save.onclick = () =>
          run(async () => {
            state.dirty = false;
            try {
              await update({ kind: 'upsert', annotation: { ...a, note: input.value }, expected: state.base });
            } catch (e) {
              state.dirty = true;
              throw e;
            }
            status('批注已保存');
          });
        const remove = document.createElement('button');
        remove.textContent = '删除标注';
        let confirm = false;
        remove.onclick = () => {
          if (!confirm) {
            confirm = true;
            remove.textContent = '确认删除';
            return;
          }
          void run(async () => {
            await update({ kind: 'delete', id: a.id, expected: a });
            status('标注已删除');
          });
        };
        actions.append(save, remove);
        card.append(actions);
        list.append(card);
      }
      if (focusedId && editors.has(focusedId)) editors.get(focusedId).input.focus();
    }
    node.addEventListener('input', (e) => {
      if (e.target.matches('[data-field],[data-page-note]')) {
        if (!dirty) draftBase = { note: value.note, meta: value.meta };
        dirty = true;
      }
    });
    $('[data-save]').onclick = () =>
      run(async () => {
        const note = $('[data-page-note]').value,
          patch = {};
        for (const k of ['folder', 'tags']) patch[k] = $('[data-field=' + k + ']').value.trim();
        for (const k of ['starred', 'read']) patch[k] = $('[data-field=' + k + ']').checked;
        await update({
          kind: 'organize',
          text: note,
          patch,
          base: draftBase || { note: value.note, meta: value.meta }
        });
        dirty = false;
        values();
        status('笔记与整理已保存在本机');
      });
    $('[data-sync]').hidden = !sync;
    $('[data-sync]').onclick = () =>
      run(async () => {
        if (dirty || [...editors.values()].some((e) => e.dirty)) throw Error('请先保存正在编辑的笔记');
        set(await sync(), { reset: true });
        status('已与客户端同步');
      });
    $('[data-export]').onclick = () =>
      run(() => {
        if (dirty || [...editors.values()].some((e) => e.dirty)) throw Error('请先保存正在编辑的笔记');
        return exportNotes(value);
      });
    $('[data-visible]').onchange = () => {
      visible = $('[data-visible]').checked;
      changed(value, { visible });
    };
    set(value, { reset: true });
    return {
      node,
      set,
      get: () => value,
      isBusy: () => busy,
      hasDraft: () => dirty || [...editors.values()].some((e) => e.dirty),
      focus(id) {
        editors.get(id)?.input.focus();
      },
      showMissing(ids) {
        for (const card of node.querySelectorAll('[data-mark-card]')) {
          const missing = ids.includes(card.dataset.markCard);
          card.classList.toggle('unresolved', missing);
          card.querySelector('.notes-quote').title = missing ? '原文已变化，暂未定位' : '定位原文';
        }
      },
      dispose() {
        node.remove();
      }
    };
  }
  globalThis.ShiyeReadingEditor = { mount };
})();
