(() => {
  function enhance(scope) {
    for (const select of scope.querySelectorAll('select:not([data-customized])')) {
      select.dataset.customized = 'true';
      select.classList.add('custom-select-value');
      select.tabIndex = -1;
      select.setAttribute('aria-hidden', 'true');

      const wrap = document.createElement('span');
      wrap.className = 'custom-select';
      select.before(wrap);
      wrap.append(select);

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'custom-select-trigger';
      trigger.setAttribute('aria-haspopup', 'listbox');
      trigger.setAttribute('aria-expanded', 'false');
      const explicitLabel = select.id && scope.querySelector(`label[for="${CSS.escape(select.id)}"]`);
      const implicitLabel = select.closest('label');
      const labelNode = explicitLabel || implicitLabel;
      const labelCopy = labelNode?.cloneNode(true);
      labelCopy?.querySelectorAll('select').forEach(node => node.remove());
      const label = (labelCopy?.innerText || labelCopy?.textContent)?.trim().replace(/\s+/g, ' ');
      if (label) trigger.setAttribute('aria-label', label);
      const value = document.createElement('span');
      value.className = 'custom-select-value-text';
      const arrow = document.createElement('span');
      arrow.className = 'custom-select-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.innerHTML = '<svg viewBox="0 0 16 16" focusable="false"><path d="m4 6 4 4 4-4"/></svg>';
      trigger.append(value, arrow);

      const list = document.createElement('div');
      list.className = 'custom-select-list';
      list.id = `archive-select-${crypto.randomUUID()}`;
      trigger.setAttribute('aria-controls', list.id);
      list.popover = 'auto';
      list.setAttribute('role', 'listbox');
      const options = [...select.options].map((option, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'custom-select-option';
        item.setAttribute('role', 'option');
        item.textContent = option.textContent;
        item.dataset.index = String(index);
        item.onclick = () => choose(index);
        list.append(item);
        return item;
      });
      wrap.append(trigger);
      (scope.nodeType === Node.DOCUMENT_NODE ? scope.body : scope).append(list);

      function sync() {
        const selected = select.selectedIndex;
        value.textContent = select.options[selected]?.textContent || '';
        options.forEach((item, index) => {
          const active = index === selected;
          item.setAttribute('aria-selected', String(active));
          if (active) item.dataset.selected = 'true';
          else delete item.dataset.selected;
        });
      }
      function position() {
        const rect = trigger.getBoundingClientRect();
        const width = Math.min(Math.max(rect.width, 160), innerWidth - 16);
        const height = Math.min(list.scrollHeight || 240, 280, innerHeight - 16);
        const below = innerHeight - rect.bottom;
        const top = below >= Math.min(height, 180) || rect.top < height ? rect.bottom + 4 : rect.top - height - 4;
        list.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, rect.left))}px`;
        list.style.top = `${Math.max(8, Math.min(innerHeight - height - 8, top))}px`;
        list.style.minWidth = `${width}px`;
      }
      function open(index = select.selectedIndex) {
        for (const other of scope.querySelectorAll('.custom-select-list:popover-open')) other.hidePopover();
        position();
        list.showPopover();
        trigger.setAttribute('aria-expanded', 'true');
        const target = options[Math.max(0, index)];
        target?.focus();
        target?.scrollIntoView({block: 'nearest'});
      }
      function close(returnFocus = true) {
        if (list.matches(':popover-open')) list.hidePopover();
        trigger.setAttribute('aria-expanded', 'false');
        if (returnFocus) trigger.focus();
      }
      function choose(index) {
        if (index < 0 || index >= select.options.length) return;
        select.selectedIndex = index;
        sync();
        select.dispatchEvent(new Event('change', {bubbles: true}));
        close();
      }
      trigger.onclick = () => list.matches(':popover-open') ? close(false) : open();
      trigger.onkeydown = event => {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault();
          open(event.key === 'ArrowUp' ? select.selectedIndex - 1 : select.selectedIndex);
        }
      };
      list.onkeydown = event => {
        const index = options.indexOf(select.getRootNode().activeElement || select.ownerDocument.activeElement);
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        if (event.key === 'Tab') { close(false); return; }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(index); return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          options[next]?.focus();
          options[next]?.scrollIntoView({block: 'nearest'});
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const start = Math.max(0, index + 1);
          const match = [...options.slice(start), ...options.slice(0, start)].findIndex(item => item.textContent.trim().toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
          if (match >= 0) options[(start + match) % options.length]?.focus();
        }
      };
      list.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(list.matches(':popover-open'))));
      select.addEventListener('change', sync);
      sync();
    }
  }

  globalThis.ArchiveCustomSelect = {enhance};
})();
