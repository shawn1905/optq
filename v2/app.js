/* 期权历史行情 2.0 —— 结构与 HiTick option-history 一致，配色用我们自己的 */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const API = '../api';
  const COLS = [
    ['symbol', '合约'], ['theta', 'Theta'], ['vega', 'Vega'], ['gamma', 'Gamma'], ['delta', 'Delta'],
    ['impliedVol', 'IV'], ['volume', '成交量'], ['openInterest', '持仓量'],
    ['previousSettlement', '昨结价'], ['previousClose', '昨收价'],
    ['low', '最低价'], ['high', '最高价'], ['open', '开盘价'], ['price', '收盘 / 最新'],
  ];

  const S = {
    meta: null, dates: [], date: null, code: null, chain: null, rows: [],
    month: null, sel: null, intraday: null, charts: {}, seq: 0, intraSeq: 0,
  };

  const num = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—'
    : new Intl.NumberFormat('en-US', { maximumFractionDigits: d }).format(v);
  const price = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : v.toFixed(d);
  const compact = v => {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return String(Math.round(v));
  };
  const pct = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
  const dstr = d => String(d).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');

  async function api(path) {
    const r = await fetch(API + path, { cache: 'no-store' });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  /* ---------------- 列头 ---------------- */
  function buildColumns() {
    $('callColumns').innerHTML = COLS.map(([k, l], i) => `<span${i === 0 ? ' class="oh-symbol"' : ''}>${l}</span>`).join('');
    $('putColumns').innerHTML = COLS.slice().reverse().map(([k, l], i) => `<span${i === 0 ? ' class="oh-symbol"' : ''}>${l}</span>`).join('');
  }

  /* ---------------- 链数据 ---------------- */
  function monthRows() { return S.rows.filter(r => r.s_month === S.month); }

  function valueOf(row, key) {
    if (!row) return '—';
    switch (key) {
      case 'symbol': return String(row.code).slice(0, 8);
      case 'impliedVol': return row.iv == null ? '—' : (row.iv * 100).toFixed(2);
      case 'volume': return compact(row.volume);
      case 'openInterest': return compact(row.oi_web);
      case 'previousSettlement': return price(row.pre_settle, 4);
      case 'previousClose': return price(row.pre_close, 4);
      case 'low': case 'high': case 'open': return row.close > 0 && row[key] > 0 ? price(row[key], 4) : '—';
      case 'price': return row.close > 0 ? price(row.close, 4) : '—';
      default: {
        const v = row[key];
        return Number.isFinite(v) ? v.toFixed(3) : '—';
      }
    }
  }

  function renderChain() {
    const rows = monthRows();
    const byStrike = new Map();
    rows.forEach(r => {
      if (!byStrike.has(r.strike)) byStrike.set(r.strike, { strike: r.strike, C: null, P: null });
      byStrike.get(r.strike)[r.call_put] = r;
    });
    const list = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
    const spot = S.chain.quote ? S.chain.quote.close : null;

    $('chainRows').innerHTML = list.map(g => {
      const callCells = COLS.map(([k]) => `<span data-column="${k}" class="${k === 'symbol' ? 'oh-symbol' : k === 'price' ? 'oh-quote-price' : ''}">${valueOf(g.C, k)}</span>`).join('');
      const putCells = COLS.slice().reverse().map(([k]) => `<span data-column="${k}" class="${k === 'symbol' ? 'oh-symbol' : k === 'price' ? 'oh-quote-price' : ''}">${valueOf(g.P, k)}</span>`).join('');
      const sel = (g.C && g.C.code === S.sel) || (g.P && g.P.code === S.sel);
      const atm = spot && Math.abs(g.strike - spot) === Math.min(...list.map(x => Math.abs(x.strike - spot)));
      return `<tr data-strike="${g.strike}" class="${sel ? 'is-selected' : ''}">
        <td class="oh-leg oh-call"><div class="oh-leg-viewport"><div class="oh-quote-grid oh-call" data-code="${g.C ? g.C.code : ''}">${callCells}</div></div></td>
        <td class="oh-strike${atm ? ' is-atm' : ''}">${g.strike.toFixed(3)}</td>
        <td class="oh-leg oh-put"><div class="oh-leg-viewport"><div class="oh-quote-grid oh-put" data-code="${g.P ? g.P.code : ''}">${putCells}</div></div></td>
      </tr>`;
    }).join('');

    $('chainEmpty').hidden = list.length > 0;
    $('chainMeta').textContent = `按行权价排列 · ${rows.length} 个合约`;
    $('chainQuality').textContent = spot
      ? `标的 ${price(spot, 3)} · 平值 ${list.reduce((a, b) => Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a, list[0]).strike.toFixed(3)}`
      : '';

    $('chainRows').onclick = ev => {
      const grid = ev.target.closest('.oh-quote-grid');
      if (!grid || !grid.dataset.code) return;
      S.sel = grid.dataset.code;
      renderChain();
      loadIntraday();
    };
  }

  /* ---------------- 图表 ---------------- */
  function chartColors() {
    const css = getComputedStyle(document.documentElement);
    const g = n => css.getPropertyValue(n).trim();
    return {
      text: g('--muted'), line: g('--line'), bg: g('--panel'),
      up: g('--up'), down: g('--down'), avg: g('--oh-average'),
      vol: g('--series-1'), oi: g('--series-4'), iv: g('--series-4'),
    };
  }

  function baseOptions(c) {
    const minute = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
    return {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: c.bg }, textColor: c.text, fontSize: 10, fontFamily: 'inherit',
        attributionLogo: true,
        panes: { separatorColor: c.line, separatorHoverColor: c.line, enableResize: false },
      },
      grid: { vertLines: { color: c.line, style: 1 }, horzLines: { color: c.line, style: 1 } },
      leftPriceScale: { visible: true, borderColor: c.line, minimumWidth: 58, scaleMargins: { top: .12, bottom: .12 } },
      rightPriceScale: { visible: true, borderColor: c.line, minimumWidth: 52, scaleMargins: { top: .12, bottom: .12 } },
      timeScale: {
        borderColor: c.line, timeVisible: true, secondsVisible: false, minBarSpacing: .01, rightOffset: 2,
        shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: t => minute.format(new Date(t * 1000)),
      },
      localization: { locale: 'zh-CN', dateFormat: 'yyyy-MM-dd', timeFormatter: t => minute.format(new Date(t * 1000)) },
      crosshair: { mode: 0, vertLine: { color: c.accent, labelBackgroundColor: c.bg }, horzLine: { color: c.accent, labelBackgroundColor: c.bg } },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false } },
    };
  }

  function buildChart(el, id) {
    const c = chartColors();
    const chart = LightweightCharts.createChart(el, baseOptions(c));
    const step = LightweightCharts.LineType.WithSteps;
    const priceSeries = chart.addSeries(LightweightCharts.BaselineSeries, {
      priceScaleId: 'left', lineType: step, lineWidth: 2, lineVisible: true,
      lastValueVisible: true, crosshairMarkerVisible: true, priceLineVisible: false,
      baseValue: { type: 'price', price: 0 },
      topLineColor: c.up, topFillColor1: 'rgba(255,77,79,.18)', topFillColor2: 'rgba(255,77,79,.03)',
      bottomLineColor: c.down, bottomFillColor1: 'rgba(46,204,113,.03)', bottomFillColor2: 'rgba(46,204,113,.18)',
    }, 0);
    const volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      priceScaleId: 'left', color: c.vol, priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false,
    }, 1);
    const oiSeries = chart.addSeries(LightweightCharts.LineSeries, {
      priceScaleId: 'right', color: c.oi, lineType: step, lineWidth: 2, priceFormat: { type: 'volume' },
      priceLineVisible: false, lastValueVisible: false,
    }, 1);
    const avgSeries = chart.addSeries(LightweightCharts.LineSeries, {
      priceScaleId: 'left', color: c.avg, lineType: step, lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
    }, 0);
    const ivSeries = chart.addSeries(LightweightCharts.LineSeries, {
      priceScaleId: 'right', lineVisible: false, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
      priceFormat: { type: 'custom', formatter: v => (v * 100).toFixed(2) + '%' },
    }, 0);
    chart.priceScale('left', 1).applyOptions({ visible: true, borderColor: c.line, scaleMargins: { top: .15, bottom: 0 } });
    chart.priceScale('right', 1).applyOptions({ visible: true, borderColor: c.line, scaleMargins: { top: .15, bottom: .05 } });
    chart.panes()[0].setStretchFactor(3);
    chart.panes()[1].setStretchFactor(1);
    S.charts[id] = { chart, priceSeries, avgSeries, ivSeries, volSeries: volumeSeries, oiSeries, el };
    return S.charts[id];
  }

  function tsOf(day, t) {
    const y = +String(day).slice(0, 4), m = +String(day).slice(4, 6) - 1, d = +String(day).slice(6, 8);
    const [hh, mm] = t.split(':').map(Number);
    return Math.round(Date.UTC(y, m, d, hh, mm) / 1000);
  }

  function plot(id, bars, ivs, prevClose, opts = {}) {
    const c = chartColors();
    const view = S.charts[id] || buildChart($(id), id);
    const t = v => tsOf(S.date, v);
    const priceData = [], avgData = [], volData = [], oiData = [], ivData = [];
    let cv = 0, ca = 0, lastAvg = null;
    bars.forEach((b, i) => {
      const time = t(b.t);
      if (b.close > 0) {
        priceData.push({ time, value: b.close });
        const v = b.vol || 0, a = b.amount || 0;
        cv += v; ca += a;
        if (cv > 0) lastAvg = ca / cv / (opts.mult || 1);
        if (lastAvg != null) avgData.push({ time, value: lastAvg });
      }
      volData.push({ time, value: b.vol || 0, color: (b.close >= (b.open || b.close)) ? c.up : c.down });
      if (b.oi != null) oiData.push({ time, value: b.oi });
      if (ivs && ivs[i] != null && ivs[i] > 0.002) ivData.push({ time, value: ivs[i] });
    });
    view.priceSeries.applyOptions({
      baseValue: { type: 'price', price: prevClose || (priceData[0] && priceData[0].value) || 0 },
    });
    view.priceSeries.setData(priceData);
    view.avgSeries.setData(avgData);
    view.volSeries.setData(volData);
    view.oiSeries.setData(oiData);
    view.ivSeries.setData(ivData);
    view.chart.timeScale().fitContent();
    view.data = { priceData, avgData, volData, oiData, ivData, bars, ivs };
    return view;
  }

  /* ---------------- 分时 ---------------- */
  async function loadIntraday() {
    if (!S.sel) return;
    const my = ++S.intraSeq;
    let d = null;
    try {
      d = await api(`/intraday?code=${S.code}&date=${S.date}&contract=${S.sel}&month=${S.month}`);
    } catch (_) { d = null; }
    if (my !== S.intraSeq) return;
    S.intraday = d;
    renderCharts();
  }

  function renderCharts() {
    const d = S.intraday;
    // 标的
    if (!d || d.spot.mode !== 'minute' || !d.spot.bars.length) {
      $('underlyingEmpty').hidden = false;
      $('underlyingEmpty').textContent = !d ? '加载失败' : '该日无标的分钟数据';
      $('underlyingChart').innerHTML = '';
      S.charts.underlyingChart = null;
      $('underlyingIvReadout').textContent = '—';
    } else {
      $('underlyingEmpty').hidden = true;
      const q = S.chain.quote || {};
      plot('underlyingChart', d.spot.bars, d.atm_iv, q.pre_close, { mult: 1 });
      $('underlyingTitle').textContent = `${S.code} · ${S.date}`;
      $('underlyingBasePrice').textContent = q.pre_close ? `昨收 ${price(q.pre_close, 3)}` : '';
      $('underlyingIvReadout').textContent = (() => {
        const v = (d.atm_iv || []).filter(x => x != null);
        return v.length ? (v[v.length - 1] * 100).toFixed(2) + '%' : '—';
      })();
    }
    // 合约
    if (!d || !d.option.bars.length) {
      $('intradayEmpty').hidden = false;
      $('intradayEmpty').textContent = '该合约无分钟数据';
      $('intradayChart').innerHTML = '';
      S.charts.intradayChart = null;
      $('intradayIvReadout').textContent = '—';
    } else {
      $('intradayEmpty').hidden = true;
      const meta = d.option.meta || {};
      const row = S.rows.find(r => r.code === S.sel) || {};
      plot('intradayChart', d.option.bars, d.option.bars.map(b => b.iv), row.pre_close, { mult: 10000 });
      $('intradayTitle').textContent = `${meta.name || ''} · ${meta.call_put === 'C' ? '认购' : '认沽'} K${meta.strike}`;
      $('basePrice').textContent = row.pre_close ? `昨收 ${price(row.pre_close, 4)}` : '';
      const ivs = d.option.bars.map(b => b.iv).filter(v => v != null && v > 0.002);
      $('intradayIvReadout').textContent = ivs.length ? (ivs[ivs.length - 1] * 100).toFixed(2) + '%' : '—';
    }
    attachHover('underlyingChart', 'underlyingReadout', 'underlyingSnapshot', 1);
    attachHover('intradayChart', 'intradayReadout', 'intradaySnapshot', 10000);
    ['underlyingChart', 'intradayChart'].forEach((cid, idx) => {
      const v = S.charts[cid];
      if (!v || !v.data || !v.data.bars.length) return;
      const i = v.data.bars.length - 1;
      setSnap(idx === 0 ? 'underlyingSnapshot' : 'intradaySnapshot', v.data.bars[i], v.data, i, idx === 0 ? 1 : 10000);
    });
  }

  function attachHover(chartId, readoutId, snapId, mult) {
    const view = S.charts[chartId];
    if (!view) return;
    view.chart.subscribeCrosshairMove(param => {
      const rd = $(readoutId);
      if (!param.time || !param.point) { rd.textContent = ''; return; }
      const bar = (view.data.priceData || []).find(p => p.time === param.time);
      if (!bar) { rd.textContent = ''; return; }
      const i = (view.data.bars || []).findIndex(b => tsOf(S.date, b.t) === param.time);
      const b = view.data.bars[i] || {};
      const p = view.chart.priceScale('left');
      rd.innerHTML = `${b.t || ''}　价格 <b>${price(b.close, chartId === 'intradayChart' ? 4 : 3)}</b>　均价 <b>${price(view.data.avgData[i] ? view.data.avgData[i].value : null, 4)}</b>　量 <b>${compact(b.vol || 0)}</b>`;
      // 快照
      setSnap(snapId, b, view.data, i, mult);
    });
  }

  function setSnap(prefix, b, data, i, mult) {
    const q = S.chain.quote || {};
    const v = data.priceData[i] ? data.priceData[i].value : null;
    const avg = data.avgData[i] ? data.avgData[i].value : null;
    const prev = prefix.startsWith('underlying') ? q.pre_close : (S.rows.find(r => r.code === S.sel) || {}).pre_close;
    $(prefix + 'Time').textContent = b.t || '';
    $(prefix + 'Price').textContent = price(v, prefix.startsWith('underlying') ? 3 : 4);
    $(prefix + 'AveragePrice').textContent = price(avg, 4);
    const chg = (v != null && prev) ? v - prev : null;
    $(prefix + 'Change').textContent = chg == null ? '—' : (chg >= 0 ? '+' : '') + chg.toFixed(4);
    $(prefix + 'ChangePct').textContent = chg == null ? '—' : pct(chg / prev);
    $(prefix + 'OpenInterest').textContent = b.oi != null ? compact(b.oi) : '—';
    $(prefix + 'MinuteVolume').textContent = compact(b.vol || 0);
    let cum = 0; for (let k = 0; k <= i; k++) cum += (data.bars[k] && data.bars[k].vol) || 0;
    $(prefix + 'CumulativeVolume').textContent = compact(cum);
  }

  /* ---------------- 选择器 ---------------- */
  function renderPickers() {
    $('pickerTargetList').innerHTML = S.meta.codes.map(c => `
      <button class="oh-picker-item" data-code="${c.code}">
        <span class="oh-picker-copy"><strong>${c.code}</strong><small>最近 ${dstr(c.last || '')}</small></span>
      </button>`).join('');
    $('pickerTargetList').onclick = ev => {
      const b = ev.target.closest('[data-code]');
      if (!b) return;
      S.code = b.dataset.code;
      $('underlyingPicker').close();
      loadDates();
    };
  }

  function renderCalendar(year, month) {
    const days = S.dates.filter(d => Math.floor(d / 100) === year * 100 + month);
    const first = new Date(year, month - 1, 1);
    const start = (first.getDay() + 6) % 7; // 周一为首列
    const cells = [];
    for (let i = 0; i < start; i++) cells.push('<td></td>');
    const lastDay = new Date(year, month, 0).getDate();
    for (let d = 1; d <= lastDay; d++) {
      const key = year * 10000 + month * 100 + d;
      const has = days.includes(key);
      cells.push(`<td>${has ? `<button class="oh-calendar-day" data-date="${key}">${d}</button>` : `<span class="oh-calendar-day is-empty">${d}</span>`}</td>`);
    }
    $('calendarDays').innerHTML = `<tr>${cells.join('')}</tr>`;
    $('calendarMonth').textContent = `${year} 年 ${month} 月`;
    $('calendarStatus').textContent = days.length ? `${days.length} 个交易日` : '该月无数据';
    $('calendarDays').onclick = ev => {
      const b = ev.target.closest('[data-date]');
      if (!b) return;
      S.date = +b.dataset.date;
      $('tradingDayPicker').close();
      loadChain();
    };
    return { year, month };
  }

  /* ---------------- 加载 ---------------- */
  async function loadDates() {
    const { dates } = await api(`/dates?code=${S.code}`);
    S.dates = dates;
    const meta = S.meta.codes.find(c => c.code === S.code);
    S.date = (meta && meta.last1m && dates.includes(meta.last1m)) ? meta.last1m : dates[dates.length - 1];
    $('dateValue').textContent = dstr(S.date);
    $('targetSummary').textContent = S.code;
    await loadChain();
  }

  async function loadChain() {
    const my = ++S.seq;
    const chain = await api(`/chain?code=${S.code}&date=${S.date}`);
    if (my !== S.seq) return;
    S.chain = chain;
    S.rows = chain.rows.map(r => ({
      ...r,
      pre_close: r.pre_close !== undefined && r.pre_close !== null ? r.pre_close : r.close - (r.change || 0),
    }));
    S.month = chain.months[0];
    const spot = chain.quote ? chain.quote.close : null;
    const cands = S.rows.filter(r => r.s_month === S.month && r.call_put === 'C');
    S.sel = (spot && cands.length ? cands.reduce((a, b) => Math.abs(a.strike - spot) <= Math.abs(b.strike - spot) ? a : b).code
      : (cands[0] || S.rows[0] || {}).code);
    if (chain.quote) {
      $('summarySymbol').textContent = `${chain.quote.targetname || S.code} · ${S.code}`;
      const q = chain.quote;
      $('summaryPrice').innerHTML = `${price(q.close, 3)} <span class="${cls(q.change)}">${pct((q.change || 0) / 100)}</span>`;
      $('summaryPrice').classList.toggle('up', (q.change || 0) > 0);
      $('summaryPrice').classList.toggle('down', (q.change || 0) < 0);
    }
    renderChain();
    await loadIntraday();
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    $('refresh').onclick = () => { loadChain(); };
    $('dateTrigger').onclick = () => {
      const y = Math.floor(S.date / 10000), m = Math.floor(S.date / 100) % 100;
      S.cal = renderCalendar(y, m);
      $('tradingDayPicker').showModal();
    };
    $('calendarClose').onclick = () => $('tradingDayPicker').close();
    $('calendarPrev').onclick = () => {
      let { year, month } = S.cal; month--; if (month < 1) { month = 12; year--; }
      S.cal = renderCalendar(year, month);
    };
    $('calendarNext').onclick = () => {
      let { year, month } = S.cal; month++; if (month > 12) { month = 1; year++; }
      S.cal = renderCalendar(year, month);
    };
    $('targetTrigger').onclick = () => {
      $('pickerTargetList').hidden = false;
      $('pickerExpiryList').parentElement.hidden = true;
      $('underlyingPicker').showModal();
    };
    $('pickerClose').onclick = () => $('underlyingPicker').close();
    $('pickerBack').onclick = () => $('underlyingPicker').close();
    $('locateAtm').onclick = () => {
      const el = document.querySelector('.oh-strike.is-atm');
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    $('themeToggle').onclick = () => {
      const light = document.documentElement.dataset.theme !== 'light';
      document.documentElement.dataset.theme = light ? 'light' : 'dark';
      $('themeToggle').querySelector('.theme-toggle-label').textContent = light ? '浅色' : '深色';
      Object.keys(S.charts).forEach(k => S.charts[k] = null);
      $('underlyingChart').innerHTML = ''; $('intradayChart').innerHTML = '';
      renderCharts();
    };
  }

  async function boot() {
    buildColumns();
    bind();
    S.meta = await api('/meta');
    const first = S.meta.codes.find(c => c.code === '510050') || S.meta.codes[0];
    S.code = first.code;
    renderPickers();
    await loadDates();
    $('refreshStatus').textContent = '已加载';
  }

  window.__V2 = S;

  boot().catch(err => {
    $('pageNotice').hidden = false;
    $('pageNotice').textContent = '加载失败：' + err.message;
  });
})();
