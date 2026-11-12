/* Calendar availability comes only from the historical catalog. */
window.OptionHistoryCalendar = (() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const DAY = 86400000;
  const parseDay = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const time = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value ? time : null;
  };
  const monthOf = day => Number(day.slice(0,4)) * 12 + Number(day.slice(5,7)) - 1;
  const dayString = time => new Date(time).toISOString().slice(0,10);
  const isWeekday = day => {
    const weekday = new Date(day + 'T00:00:00Z').getUTCDay();
    return weekday >= 1 && weekday <= 5;
  };
  function create({onSelect}) {
    const dialog = $('tradingDayPicker'), trigger = $('dateTrigger');
    const narrow = window.matchMedia('(max-width:640px)');
    let entries = new Map(), available = [], selected = '', currentMonth = null, firstMonth = null, lastMonth = null, focusDay = '', restoreFocus = true;
    const canSelect = day => isWeekday(day) && entries.get(day)?.hasTicks === true && entries.get(day)?.hasMetadata === true;
    function reason(day) {
      const entry = entries.get(day);
      if (!entry) return '无数据覆盖';
      if (entry.hasTicks !== true && entry.hasMetadata !== true) return '缺少行情与合约属性';
      if (entry.hasTicks !== true) return '缺少行情';
      if (entry.hasMetadata !== true) return '缺少当日合约属性';
      return '可选择';
    }
    function position() {
      if (!dialog.open) return;
      if (narrow.matches) { for (const key of ['top','left','maxHeight']) dialog.style[key] = ''; return; }
      const rect = trigger.getBoundingClientRect(), height = dialog.getBoundingClientRect().height;
      const top = Math.max(8,Math.min(rect.bottom + 8,window.innerHeight - height - 8));
      Object.assign(dialog.style,{top:`${top}px`,left:`${Math.max(8,Math.min(rect.left,window.innerWidth - dialog.offsetWidth - 8))}px`,maxHeight:`${Math.max(160,window.innerHeight - top - 8)}px`});
    }
    function close(restore = true) {
      restoreFocus = restore;
      if (dialog.open) dialog.close();
      trigger.setAttribute('aria-expanded','false');
    }
    function monthDays() { return available.filter(day => monthOf(day) === currentMonth); }
    function render() {
      if (currentMonth === null) return;
      const year = Math.floor(currentMonth / 12), month = currentMonth % 12;
      const first = Date.UTC(year,month,1), offset = (new Date(first).getUTCDay() + 6) % 7;
      const count = new Date(Date.UTC(year,month + 1,0)).getUTCDate(), valid = monthDays();
      if (!valid.includes(focusDay)) focusDay = valid.includes(selected) ? selected : valid[0] || '';
      $('calendarMonth').textContent = `${year}年${month + 1}月`;
      $('calendarPrev').disabled = currentMonth <= firstMonth;
      $('calendarNext').disabled = currentMonth >= lastMonth;
      const cells = [];
      for (let index = 0; index < Math.ceil((offset + count) / 7) * 7; index++) {
        if (index % 7 >= 5) continue;
        const dayNumber = index - offset + 1;
        if (dayNumber < 1 || dayNumber > count) { cells.push('<td></td>'); continue; }
        const day = dayString(first + (dayNumber - 1) * DAY), enabled = canSelect(day), active = day === selected;
        cells.push(`<td role="gridcell" aria-selected="${active}"><button type="button" class="oh-calendar-day" data-trading-day="${day}" aria-pressed="${active}" aria-label="${day}，${active ? '已选择，' : ''}${reason(day)}" title="${day} · ${reason(day)}" tabindex="${day === focusDay ? '0' : '-1'}"${enabled ? '' : ' disabled'}>${dayNumber}</button></td>`);
      }
      $('calendarDays').innerHTML = Array.from({length:cells.length / 5},(_,index) => cells.slice(index * 5,index * 5 + 5))
        .filter(row => row.some(cell => cell !== '<td></td>'))
        .map(row => `<tr role="row">${row.join('')}</tr>`).join('');
      $('calendarStatus').textContent = valid.length ? `本月 ${valid.length} 个可选交易日` : '本月没有同时有行情和合约属性的交易日';
      position();
    }
    function focusCurrent() {
      ($('calendarDays').querySelector('[tabindex="0"]') || (!$('calendarNext').disabled && $('calendarNext')) || (!$('calendarPrev').disabled && $('calendarPrev')) || $('calendarClose')).focus();
    }
    function setMonth(month,focus = false) {
      if (month < firstMonth || month > lastMonth) return;
      currentMonth = month; render();
      if (focus) focusCurrent();
    }
    function open() {
      if (trigger.disabled || !available.length) return;
      const initial = canSelect(selected) ? selected : available[available.length - 1];
      currentMonth = monthOf(initial); focusDay = initial; render();
      dialog.showModal(); trigger.setAttribute('aria-expanded','true'); position(); focusCurrent();
    }
    function focusDate(day) {
      if (!day || !canSelect(day)) return;
      focusDay = day; currentMonth = monthOf(day); render(); focusCurrent();
    }
    trigger.addEventListener('click',open);
    trigger.addEventListener('keydown',event => { if (event.key === 'ArrowDown') { event.preventDefault(); open(); } });
    $('calendarClose').addEventListener('click',() => close());
    $('calendarPrev').addEventListener('click',() => setMonth(currentMonth - 1));
    $('calendarNext').addEventListener('click',() => setMonth(currentMonth + 1));
    dialog.addEventListener('click',event => {
      const button = event.target.closest('[data-trading-day]'), day = button?.dataset.tradingDay;
      if (day && !button.disabled && canSelect(day)) { close(); onSelect(day); }
      else if (event.target === dialog) {
        const rect = dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      }
    });
    dialog.addEventListener('cancel',event => { event.preventDefault(); close(); });
    dialog.addEventListener('close',() => { trigger.setAttribute('aria-expanded','false'); if (restoreFocus && !trigger.disabled) trigger.focus(); });
    dialog.addEventListener('keydown',event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      const day = event.target.dataset.tradingDay;
      if (!day) return;
      const index = available.indexOf(day);
      if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)) event.preventDefault();
      if (event.key === 'ArrowLeft') focusDate(available[index - 1]);
      else if (event.key === 'ArrowRight') focusDate(available[index + 1]);
      else if (event.key === 'ArrowUp') focusDate(available.filter(value => parseDay(value) <= parseDay(day) - 7 * DAY).at(-1));
      else if (event.key === 'ArrowDown') focusDate(available.find(value => parseDay(value) >= parseDay(day) + 7 * DAY));
      else if (event.key === 'Home') focusDate(monthDays()[0]);
      else if (event.key === 'End') focusDate(monthDays().at(-1));
      else if (event.key === 'PageUp') setMonth(currentMonth - 1,true);
      else if (event.key === 'PageDown') setMonth(currentMonth + 1,true);
    });
    window.addEventListener('resize',position);
    return {
      setCatalog(catalog) {
        close(false);
        entries = new Map((catalog?.dates || []).filter(entry => parseDay(entry.tradingDay) !== null).map(entry => [entry.tradingDay,entry]));
        const days = [...entries.keys()].sort();
        available = days.filter(canSelect); selected = parseDay(catalog?.tradingDay) !== null ? catalog.tradingDay : '';
        firstMonth = days.length ? monthOf(days[0]) : null; lastMonth = days.length ? monthOf(days[days.length - 1]) : null;
        currentMonth = firstMonth === null ? null : Math.max(firstMonth,Math.min(lastMonth,selected ? monthOf(selected) : lastMonth));
        $('dateValue').textContent = selected || '暂无可用日期';
        trigger.title = selected ? `${selected} · ${reason(selected)}` : '暂无同时有行情和合约属性的交易日';
        trigger.disabled = !available.length;
        render();
      },
      setDisabled(disabled) { trigger.disabled = Boolean(disabled) || !available.length; if (disabled) close(false); },
      reset() {
        close(false); entries = new Map(); available = []; selected = focusDay = ''; currentMonth = firstMonth = lastMonth = null;
        trigger.disabled = true; trigger.title = ''; $('dateValue').textContent = '—'; $('calendarDays').replaceChildren(); $('calendarMonth').textContent = ''; $('calendarStatus').textContent = '';
        $('calendarPrev').disabled = $('calendarNext').disabled = true;
      },
    };
  }
  return {create};
})();
