/* A single underlying control, with conditional expiry and multiplier steps. */
window.OptionHistoryPicker = (() => {
  'use strict';
  const M = window.OptionHistoryModel, $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function create({onSelect}) {
    const dialog = $('underlyingPicker'), trigger = $('targetTrigger');
    const narrow = window.matchMedia('(max-width:640px)');
    let groups = [], selected = null, target = null, expiry = null, step = 'target', restoreFocus = true;
    const label = group => `${group.name}${group.name === group.symbol ? '' : ' · ' + group.symbol}${group.referenceFuture ? ' · 参考期货' : ''}`;
    const expiries = group => [...new Set(group?.series.map(series => series.expiry) || [])].sort();
    const choices = () => target?.series.filter(series => series.expiry === expiry) || [];
    const listId = value => ({target:'pickerTargetList',expiry:'pickerExpiryList',multiplier:'pickerMultiplierList'}[value]);
    function position() {
      if (!dialog.open) return;
      if (narrow.matches) { for (const key of ['top','left','width','maxHeight']) dialog.style[key] = ''; return; }
      const rect = trigger.getBoundingClientRect(), width = Math.min(850,window.innerWidth - 32);
      const top = Math.min(rect.bottom + 8,Math.max(16,window.innerHeight - 300));
      Object.assign(dialog.style,{top:`${top}px`,left:`${Math.max(16,Math.min(rect.left,window.innerWidth - width - 16))}px`,width:`${width}px`,maxHeight:`${Math.max(240,window.innerHeight - top - 16)}px`});
    }
    function focusList() {
      const list = $(listId(step));
      (list.querySelector('[aria-current="true"]') || list.querySelector('button') || $('targetSearch')).focus();
    }
    function close(restore = true) {
      restoreFocus = restore;
      if (dialog.open) dialog.close();
      trigger.setAttribute('aria-expanded','false');
    }
    function commit(series) {
      if (!series) return;
      close(); onSelect(series.id);
    }
    function selectTarget(key) {
      target = groups.find(group => group.key === key); if (!target) return;
      const dates = expiries(target); expiry = dates.length === 1 ? dates[0] : null;
      if (dates.length > 1) step = 'expiry';
      else if (choices().length > 1) step = 'multiplier';
      else { commit(choices()[0]); return; }
      render(); focusList();
    }
    function selectExpiry(value) {
      expiry = value;
      if (choices().length === 1) { commit(choices()[0]); return; }
      step = 'multiplier'; render(); focusList();
    }
    function back() {
      if (step === 'multiplier' && expiries(target).length > 1) step = 'expiry';
      else step = 'target';
      render(); focusList();
    }
    function render() {
      const query = $('targetSearch').value.trim().toLocaleLowerCase();
      const shown = groups.filter(group => !query || group.searchTerms.join(' ').toLocaleLowerCase().includes(query));
      $('pickerTargetList').innerHTML = shown.map(group => {
        const dates = expiries(group), same = group.key === (target?.key || (selected && M.underlyingKey(selected)));
        const source = groups.some(other => other.key !== group.key && other.exchange === group.exchange && other.symbol === group.symbol) ? ` · ${group.channel}` : '';
        const next = dates.length > 1 || group.series.length > 1;
        return `<button type="button" class="oh-picker-option" data-target="${esc(group.key)}" aria-current="${same}"><span><strong>${esc(label(group))}</strong><small>${esc(group.exchange + source)} · ${dates.length > 1 ? dates.length + ' 个到期日' : esc(dates[0] || '')}</small></span><span class="oh-picker-arrow" aria-hidden="true">${next ? '›' : selected && M.underlyingKey(selected) === group.key ? '✓' : ''}</span></button>`;
      }).join('');
      $('pickerNoResults').hidden = shown.length > 0;
      const dates = expiries(target);
      $('expiryPanel').hidden = !target || dates.length < 2;
      $('pickerExpiryList').innerHTML = dates.map(date => `<button type="button" class="oh-picker-option" data-expiry="${esc(date)}" aria-current="${date === expiry}"><span><strong>${esc(date)}</strong><small>${target.series.filter(series => series.expiry === date).length > 1 ? '选择合约乘数' : '单一乘数 · × ' + M.number(target.series.find(series => series.expiry === date).multiplier,4)}</small></span><span class="oh-picker-arrow" aria-hidden="true">${target.series.filter(series => series.expiry === date).length > 1 ? '›' : ''}</span></button>`).join('');
      const variants = choices(); $('multiplierPanel').hidden = variants.length < 2;
      $('pickerMultiplierList').innerHTML = variants.map(series => `<button type="button" class="oh-picker-option" data-series="${esc(series.id)}" aria-current="${series.id === selected?.id}"><span><strong>× ${esc(M.number(series.multiplier,4))}</strong><small>${esc(variants.some(other => other.id !== series.id && other.multiplier === series.multiplier) ? series.label || series.id : '合约乘数')}</small></span><span class="oh-picker-arrow" aria-hidden="true">${series.id === selected?.id ? '✓' : ''}</span></button>`).join('');
      dialog.dataset.step = step;
      $('pickerBack').hidden = step === 'target';
      $('pickerPath').textContent = step === 'target' ? '标的 → 到期日 → 乘数' : [target && label(target), step === 'multiplier' && expiry].filter(Boolean).join(' / ');
      position();
    }
    function open() {
      if (trigger.disabled || !groups.length) return;
      $('targetSearch').value = ''; target = groups.find(group => group.key === (selected && M.underlyingKey(selected))) || null;
      expiry = selected?.expiry || null; step = 'target'; render();
      dialog.showModal(); trigger.setAttribute('aria-expanded','true'); position(); $('targetSearch').focus();
    }
    trigger.addEventListener('click',open);
    trigger.addEventListener('keydown',event => { if (event.key === 'ArrowDown') { event.preventDefault(); open(); } });
    $('pickerClose').addEventListener('click',() => close());
    $('pickerBack').addEventListener('click',back);
    $('targetSearch').addEventListener('input',() => { step = 'target'; target = null; expiry = null; render(); });
    dialog.addEventListener('click',event => {
      const button = event.target.closest('button');
      if (button?.dataset.target) selectTarget(button.dataset.target);
      else if (button?.dataset.expiry) selectExpiry(button.dataset.expiry);
      else if (button?.dataset.series) commit(choices().find(series => series.id === button.dataset.series));
      else if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      }
    });
    dialog.addEventListener('cancel',event => { event.preventDefault(); close(); });
    dialog.addEventListener('close',() => { trigger.setAttribute('aria-expanded','false'); if (restoreFocus && !trigger.disabled) trigger.focus(); });
    dialog.addEventListener('keydown',event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      const list = event.target.closest('.oh-picker-list');
      if (event.target === $('targetSearch') && event.key === 'ArrowDown') { event.preventDefault(); $('pickerTargetList').querySelector('button')?.focus(); return; }
      if (!list) return;
      const buttons = [...list.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
      if (['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'ArrowRight') { event.preventDefault(); event.target.click(); }
      else if (event.key === 'ArrowLeft' && step !== 'target') { event.preventDefault(); back(); }
    });
    window.addEventListener('resize',position);
    return {
      setCatalog(catalog,seriesId) {
        groups = M.targets(catalog); selected = (catalog.series || []).find(series => series.id === seriesId) || null;
        trigger.disabled = !groups.length;
        const group = groups.find(item => item.key === (selected && M.underlyingKey(selected)));
        $('targetSummary').innerHTML = selected && group ? `<strong>${esc(label(group))}</strong><small>到期 ${esc(selected.expiry)} · × ${esc(M.number(selected.multiplier,4))}</small>` : '暂无可用标的';
        trigger.title = selected && group ? `${label(group)} · 到期 ${selected.expiry} · 乘数 ${selected.multiplier}` : '';
      },
      setDisabled(disabled) { trigger.disabled = disabled; if (disabled) close(false); },
      reset() { close(false); groups = []; selected = target = null; expiry = null; trigger.disabled = true; $('targetSummary').textContent = '等待标的目录'; $('pickerTargetList').replaceChildren(); $('pickerExpiryList').replaceChildren(); $('pickerMultiplierList').replaceChildren(); },
    };
  }
  return {create};
})();
