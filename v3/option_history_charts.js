/* Two minute charts share real timestamps, never prices or inferred observations. */
window.OptionHistoryCharts = (() => {
  'use strict';
  const M = window.OptionHistoryModel, $ = id => document.getElementById(id);
  const views = new Map();
  const books = new Map();
  let replayTime = null, selectionTime = null, selectionDay = '', timeSelect = null;
  let updating = false, syncingCrosshair = false, syncingRange = false, fitting = false, fitRevision = 0;
  const clock = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const minute = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const ivClock = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const snapshotClock = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'});
  const ivLabel = kind => kind === 'underlying' ? 'ATM IV' : '合约 IV';
  const ivFormat = {type:'custom',minMove:.01,formatter:value => `${value.toFixed(2)}%`};
  const colors = () => Object.fromEntries(['panel','muted','line','accent','up','down','series-1','series-4','instrument-iv','oh-average','oh-up-fill','oh-up-fade','oh-down-fill','oh-down-fade'].map(key => [key,MqdqTheme.color(key)]));
  const peerOf = view => views.get(view.kind === 'underlying' ? 'intraday' : 'underlying');
  const paired = (view,peer) => peer && view.bars.length && peer.bars.length && view.tradingDay && view.tradingDay === peer.tradingDay;
  const baseElement = kind => $(kind === 'underlying' ? 'underlyingBasePrice' : 'basePrice');
  const averagePrecision = tick => Math.max(2,M.precision(tick));
  const averagePrice = (value,tick) => M.finite(value) ? value.toFixed(averagePrecision(tick)) : '—';
  // Between minute labels the stepped price represents the previous minute
  // endpoint. Never skip a missing minute, and keep IV on its exact cycle time.
  const barAt = (view,time) => view.byTime.get(Math.floor(time / 60) * 60);
  function priceStyle(base,c) {
    const valid = M.finite(base) && base > 0;
    const transparent = 'rgba(0,0,0,0)';
    return {
      baseValue:{type:'price',price:valid ? base : 0},
      topLineColor:valid ? c.up : c.muted,bottomLineColor:valid ? c.down : c.muted,
      topFillColor1:valid ? c['oh-up-fill'] : transparent,topFillColor2:valid ? c['oh-up-fade'] : transparent,
      bottomFillColor1:valid ? c['oh-down-fade'] : transparent,bottomFillColor2:valid ? c['oh-down-fill'] : transparent,
    };
  }
  function options() {
    const c = colors();
    return {
      autoSize:true,
      layout:{background:{type:'solid',color:c.panel},textColor:c.muted,fontFamily:'"HiTick Mono","HiTick Noto Sans SC",monospace',fontSize:10,attributionLogo:true,panes:{separatorColor:c.line,separatorHoverColor:c.line,enableResize:false}},
      grid:{vertLines:{color:c.line,style:LightweightCharts.LineStyle.Dotted},horzLines:{color:c.line,style:LightweightCharts.LineStyle.Dotted}},
      leftPriceScale:{visible:true,borderColor:c.line,minimumWidth:58,scaleMargins:{top:.12,bottom:.12}},
      rightPriceScale:{visible:true,borderColor:c.line,minimumWidth:52,scaleMargins:{top:.12,bottom:.12}},
      timeScale:{borderColor:c.line,timeVisible:true,secondsVisible:true,minBarSpacing:.01,rightOffset:2,shiftVisibleRangeOnNewBar:false,tickMarkFormatter:time => minute.format(new Date(time * 1000))},
      localization:{locale:'zh-CN',dateFormat:'yyyy-MM-dd',timeFormatter:time => ivClock.format(new Date(time * 1000))},
      crosshair:{mode:LightweightCharts.CrosshairMode.Normal,vertLine:{color:c.accent,labelBackgroundColor:c.panel},horzLine:{color:c.accent,labelBackgroundColor:c.panel}},
      // Keep both axes automatically fitted when navigating the shared timeline.
      handleScroll:{mouseWheel:false,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:{time:true,price:false},axisDoubleClickReset:{time:true,price:false}},
    };
  }
  function ensure(kind) {
    if (views.has(kind)) return views.get(kind);
    const c = colors(), container = $(kind + 'Chart'), chart = LightweightCharts.createChart(container,options());
    // Hold the last observed value until the next point, without inventing ticks.
    // BaselineSeries keeps reference-based colors and fills on the stepped path.
    const lineType = LightweightCharts.LineType.WithSteps;
    const price = chart.addSeries(LightweightCharts.BaselineSeries,{priceScaleId:'left',...priceStyle(null,c),lineType,lineWidth:2,lineVisible:true,lastValueVisible:true,crosshairMarkerVisible:true,priceLineVisible:false},0);
    const volume = chart.addSeries(LightweightCharts.HistogramSeries,{priceScaleId:'left',color:c['series-1'],priceFormat:{type:'volume'},lastValueVisible:false,priceLineVisible:false},1);
    const interest = chart.addSeries(LightweightCharts.LineSeries,{priceScaleId:'right',color:c['series-4'],lineType,lineWidth:2,priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false},1);
    const average = chart.addSeries(LightweightCharts.LineSeries,{priceScaleId:'left',color:c['oh-average'],lineType,lineWidth:2,priceLineVisible:false,lastValueVisible:false},0);
    // IV overlays price on its own right scale; price and average stay on the left.
    const ivAxis = chart.addSeries(LightweightCharts.LineSeries,{priceScaleId:'right',lineVisible:false,lastValueVisible:false,priceLineVisible:false,crosshairMarkerVisible:false,priceFormat:ivFormat},0);
    chart.priceScale('left',1).applyOptions({visible:true,borderColor:c.line,scaleMargins:{top:.15,bottom:0}});
    chart.priceScale('right',1).applyOptions({visible:true,borderColor:c.line,scaleMargins:{top:.15,bottom:.05}});
    chart.panes()[0].setStretchFactor(3); chart.panes()[1].setStretchFactor(1);
    const view = {chart,price,volume,interest,average,ivAxis,iv:[],ivByTime:new Map(),ivSeries:[],ivAnchors:new Map(),ivStatus:'no_data',kind,bars:[],byTime:new Map(),timeline:[],tradingDay:'',quote:null,showInterest:true,base:null,baseLine:null};
    chart.subscribeCrosshairMove(event => moveCrosshair(view,event));
    let pointerStart = null;
    container.addEventListener('pointerdown',event => { pointerStart = {x:event.clientX,y:event.clientY}; });
    container.addEventListener('pointercancel',() => { pointerStart = null; });
    container.addEventListener('click',event => {
      const start = pointerStart; pointerStart = null;
      if (updating || event.button !== 0 || !start || Math.hypot(event.clientX-start.x,event.clientY-start.y) > 5) return;
      // Native clicks retain rapid selections that the chart's double-click
      // detector drops. Public scale dimensions exclude axes and the time bar.
      const bounds = container.getBoundingClientRect(), scale = chart.timeScale();
      const x = event.clientX - bounds.left - chart.priceScale('left',0).width();
      const y = event.clientY - bounds.top;
      if (x < 0 || x >= scale.width() || y < 0 || y >= container.clientHeight-scale.height()) return;
      const time = scale.coordinateToTime(x);
      if (!M.finite(time) || !view.timeline.includes(time)) return;
      selectTime(view,time);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange(range => syncRange(view,range));
    container.addEventListener('mouseleave',resetCrosshairs);
    views.set(kind,view);
    return view;
  }
  function selectTime(view,time) {
    // Advance immediately, so repeated keys build on the pending selection
    // rather than the last response to finish loading.
    selectionTime = time; selectionDay = view.tradingDay;
    // A closing chart point can contain a tick sent just after its 15:00 label.
    // Replay through the observed snapshots, while keeping cursor/keys on labels.
    const snapshotTimes = [...views.values()].filter(item => item.tradingDay === selectionDay)
      .map(item => item.byTime.get(time)?.snapshot?.dataTime).filter(M.finite);
    const replayAt = Math.max(time * 1000,...snapshotTimes);
    timeSelect?.({time,tradingDay:selectionDay,kind:view.kind,...(replayAt > time * 1000 ? {replayAt} : {})});
  }
  window.addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight'].includes(event.key) || event.defaultPrevented || event.isComposing
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || selectionTime === null || !timeSelect) return;
    if (event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="slider"],[role="spinbutton"],[role="menu"],[role="listbox"]')
      || document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) return;
    const candidates = [...views.values()].filter(item => item.tradingDay === selectionDay && item.timeline.length);
    const view = candidates[0];
    if (!view || updating) return;
    event.preventDefault();
    const timeline = [...new Set(candidates.flatMap(item => item.timeline))].sort((a,b) => a-b);
    const time = event.key === 'ArrowLeft' ? timeline.findLast(time => time < selectionTime)
      : timeline.find(time => time > selectionTime);
    if (M.finite(time)) selectTime(view,time);
  });
  function readout(view,time) {
    const point = time === undefined ? view.iv.at(-1) : view.ivByTime.get(time);
    const value = M.finite(point?.value) && point.value > 0 ? `${(point.value * 100).toFixed(2)}%` : '—';
    const ivTime = point?.time ?? time;
    const ivReadout = $(view.kind + 'IvReadout');
    if (ivReadout) ivReadout.textContent = view.ivStatus === 'unavailable' ? '暂不可用，请刷新重试'
      : `${value}${M.finite(ivTime) ? ` · ${ivClock.format(new Date(ivTime * 1000))}` : ' · 暂无计算数据'}`;

    const bar = time === undefined ? view.bars.at(-1) : barAt(view,time);
    snapshot(view.kind,bar,time,view.base,view.quote?.priceTick);
    if (!bar) {
      $(view.kind + 'Readout').textContent = M.finite(time) ? `${clock.format(new Date(time * 1000))} · 该分钟暂无数据` : '—';
      return;
    }
    const values = `价格 ${M.price(bar.price,view.quote?.priceTick)}${view.base && M.finite(bar.price) ? `  ${(bar.price / view.base * 100 - 100).toFixed(2)}%` : ''}`;
    $(view.kind + 'Readout').textContent = `${clock.format(new Date(bar.time * 1000))}  ${values}  均价 ${averagePrice(bar.averagePrice,view.quote?.priceTick)}  量 ${M.number(bar.volume,2)}${view.showInterest ? `  仓 ${M.number(bar.openInterest,2)}` : ''}`;
  }
  function bookRows(kind,depth) {
    if (books.get(kind)?.depth === depth) return books.get(kind).rows;
    const container = $(kind + 'SnapshotBook');
    if (!container) return [];
    container.setAttribute('aria-label',depth === 5 ? '买卖五档盘口' : '买卖一档盘口');
    container.dataset.depth = String(depth);
    const rows = [];
    for (const side of ['ask','bid']) for (let index = 0; index < depth; index++) {
      const level = side === 'ask' ? depth - index : index + 1;
      const row = document.createElement('div');
      row.className = 'oh-book-row'; row.dataset.bookSide = side; row.dataset.bookLevel = String(level);
      row.setAttribute('role','row');
      const label = document.createElement('span'), price = document.createElement('b'), volume = document.createElement('span');
      label.dataset.field = 'label'; price.dataset.field = 'price'; volume.dataset.field = 'volume';
      for (const cell of [label,price,volume]) cell.setAttribute('role','cell');
      label.textContent = `${side === 'ask' ? '卖' : '买'}${level}`;
      price.textContent = '—'; volume.textContent = '—';
      row.append(label,price,volume); rows.push({row,price,volume,side,level});
    }
    const children = rows.map(item => item.row), balance = $(kind + 'SnapshotBalance');
    if (balance) children.splice(depth,0,balance);
    container.replaceChildren(...children); books.set(kind,{depth,rows});
    return rows;
  }
  function snapshot(kind,bar,time,base,tick) {
    const value = bar?.snapshot && typeof bar.snapshot === 'object' ? bar.snapshot : null;
    const stamp = bar?.time ?? time;
    const validBase = M.finite(base) && base > 0 && M.finite(value?.lastPrice);
    const change = validBase ? Number((value.lastPrice - base).toFixed(M.precision(tick))) : null;
    const changePct = validBase ? Number(((value.lastPrice / base - 1) * 100).toFixed(2)) : null;
    const signed = (number,format) => M.finite(number) ? `${number > 0 ? '+' : ''}${format(number)}` : '—';
    const fields = {
      Time:M.finite(stamp) ? clock.format(new Date(stamp * 1000)) : '—',
      Price:M.price(value?.lastPrice,tick),
      AveragePrice:averagePrice(bar?.averagePrice,tick),
      Change:signed(change,number => M.price(number,tick)),
      ChangePct:signed(changePct,number => `${number.toFixed(2)}%`),
      OpenInterest:M.number(value?.openInterest,2),
      MinuteVolume:M.number(bar?.volume,2),
      CumulativeVolume:M.number(value?.cumulativeVolume,2),
    };
    for (const [field,text] of Object.entries(fields)) {
      const node = $(kind + 'Snapshot' + field);
      if (node) node.textContent = text;
      if (node && field === 'Time') node.title = M.finite(value?.dataTime) ? `实际行情时间 ${snapshotClock.format(new Date(value.dataTime))}` : '';
    }
    const container = $(kind + 'Snapshot');
    if (container) container.dataset.state = !bar ? 'empty' : value ? 'ready' : 'missing';
    for (const field of ['Price','Change','ChangePct']) {
      const node = $(kind + 'Snapshot' + field);
      if (node) node.dataset.tone = change === null || change === 0 ? 'neutral' : change > 0 ? 'up' : 'down';
    }
    // Zero quantities are real, but only a valid quoted price establishes depth.
    const depth = ['bids','asks'].some(side => Array.isArray(value?.[side]) && value[side].some(level =>
      Number.isInteger(level?.level) && level.level >= 2 && level.level <= 5 && M.finite(level.price) && level.price > 0)) ? 5 : 1;
    const rows = bookRows(kind,depth).map(item => {
      const levels = item.side === 'ask' ? value?.asks : value?.bids;
      const level = Array.isArray(levels) ? levels.find(entry => entry?.level === item.level) : null;
      const validPrice = M.finite(level?.price) && level.price > 0;
      const priceChange = validPrice && M.finite(base) && base > 0 ? Number((level.price - base).toFixed(M.precision(tick))) : null;
      item.price.textContent = validPrice ? M.price(level.price,tick) : '—';
      item.price.dataset.tone = priceChange === null || priceChange === 0 ? 'neutral' : priceChange > 0 ? 'up' : 'down';
      item.volume.textContent = M.number(level?.volume,2);
      const quantity = validPrice && M.finite(level?.volume) && level.volume >= 0 ? level.volume : null;
      return {...item,quantity};
    });
    // Both sides use the same maximum, so equal quantities have equal depth bars.
    const maximum = Math.max(0,...rows.map(item => item.quantity ?? 0));
    for (const item of rows) {
      const width = maximum > 0 && item.quantity !== null ? item.quantity / maximum * 100 : 0;
      item.volume.style.setProperty('--oh-depth-width',`${width}%`);
    }
    const balance = $(kind + 'SnapshotBalance');
    if (!balance) return;
    const buy = rows.filter(item => item.side === 'bid').reduce((total,item) => total + (item.quantity ?? 0),0);
    const sell = rows.filter(item => item.side === 'ask').reduce((total,item) => total + (item.quantity ?? 0),0);
    // Missing quantities are unknown, never an empty side or a fabricated 50:50.
    const complete = rows.length === depth * 2 && rows.every(item => item.quantity !== null);
    const total = buy + sell, ready = complete && M.finite(total) && total > 0;
    const buyShare = ready ? buy / total * 100 : 0;
    const buyLabel = ready ? buyShare.toFixed(1) : '—';
    const sellLabel = ready ? (100 - Number(buyLabel)).toFixed(1) : '—';
    const depthLabel = depth === 5 ? '五档' : '一档';
    balance.dataset.state = ready ? 'ready' : 'empty';
    balance.title = ready ? `${depthLabel}买量 ${M.number(buy,2)}，卖量 ${M.number(sell,2)}；买方占比 = 买量 ÷ 买卖总量` : complete ? '当前盘口暂无挂单' : '盘口报价或挂单量缺失，暂不计算买卖比';
    const balanceBar = $(kind + 'SnapshotBalanceBar');
    balanceBar.style.setProperty('--oh-sell-share',`${ready ? 100 - buyShare : 0}%`);
    balanceBar.setAttribute('aria-label',ready ? `${depthLabel}挂单量：卖方 ${sellLabel}%，买方 ${buyLabel}%` : balance.title);
  }
  function resetCrosshairs() {
    if (syncingCrosshair) return;
    syncingCrosshair = true;
    try {
      for (const view of views.values()) {
        view.chart.clearCrosshairPosition();
        readout(view,replayTime ?? undefined);
        if (replayTime !== null) {
          const target = anchor(view,barAt(view,replayTime),0,false,replayTime,false)
            || anchor(view,null,0,false,replayTime,true);
          if (target) positionCrosshair(view,target,replayTime,0);
        }
      }
    } finally { syncingCrosshair = false; }
  }
  function anchor(view,bar,paneIndex,preferInterest,time,preferIv) {
    if (paneIndex !== 1 && preferIv) {
      const point = view.ivByTime.get(time), series = view.ivAnchors.get(time);
      return series && M.finite(point?.value) ? {series,value:point.value * 100} : null;
    }
    if (!bar) return null;
    if (paneIndex !== 1) return M.finite(bar.price) ? {series:view.price,value:bar.price}
      : M.finite(bar.averagePrice) ? {series:view.average,value:bar.averagePrice} : null;
    // The series argument selects the destination pane and its value scale.
    const fields = preferInterest ? [['openInterest',view.interest],['volume',view.volume]] : [['volume',view.volume],['openInterest',view.interest]];
    const match = fields.find(([key]) => (key !== 'openInterest' || view.showInterest) && M.finite(bar[key]));
    return match ? {series:match[1],value:bar[match[0]]} : null;
  }
  function positionCrosshair(view,target,time,paneIndex) {
    let value = target.value;
    // LWC 5.2 positions on the pane's default (right) scale even when a
    // left-axis series is supplied. Preserve the price's pixel position while
    // IV owns that scale, rather than interpreting a price as an IV percentage.
    if (paneIndex !== 1 && view.ivSeries.length && !view.ivSeries.includes(target.series)) {
      const coordinate = target.series.priceToCoordinate(value);
      value = coordinate === null ? null : view.ivSeries[0].coordinateToPrice(coordinate);
    }
    if (M.finite(value)) view.chart.setCrosshairPosition(value,time,target.series);
    else view.chart.clearCrosshairPosition();
  }
  function moveCrosshair(view,event) {
    if (updating || syncingCrosshair || !view.bars.length) return;
    if (!event.point || !M.finite(event.time)) { resetCrosshairs(); return; }
    const time = event.time, peer = peerOf(view), sourceBar = barAt(view,time);
    readout(view,time);
    if (!peer) return;
    const sameDay = paired(view,peer), targetBar = sameDay ? barAt(peer,time) : null;
    const hovered = event.hoveredInfo?.series || event.hoveredSeries;
    const preferInterest = hovered === view.interest;
    const preferIv = view.ivSeries.includes(hovered);
    const source = anchor(view,sourceBar,event.paneIndex,preferInterest,time,preferIv);
    const target = anchor(peer,targetBar,event.paneIndex,preferInterest,time,preferIv);
    syncingCrosshair = true;
    try {
      if (source && target) positionCrosshair(peer,target,time,event.paneIndex);
      else peer.chart.clearCrosshairPosition();
      // Missing timestamps deliberately do not fall back to the last bar.
      if (sameDay) readout(peer,time);
      else readout(peer,null);
    } finally { syncingCrosshair = false; }
  }
  const validRange = range => range && M.finite(range.from) && M.finite(range.to) && range.to > range.from;
  function syncRange(view,range) {
    if (updating || fitting || syncingRange || !validRange(range)) return;
    const peer = peerOf(view);
    if (!paired(view,peer) || !view.timeline.length || !peer.timeline.length) return;
    const current = peer.chart.timeScale().getVisibleLogicalRange();
    if (current && Math.abs(current.from - range.from) < 1e-6 && Math.abs(current.to - range.to) < 1e-6) return;
    syncingRange = true;
    try { peer.chart.timeScale().setVisibleLogicalRange({from:range.from,to:range.to}); }
    finally { syncingRange = false; }
  }
  function setIvData(view,timeline,c) {
    const segments = M.ivSegments(view.iv);
    // LWC uses the main pane's right axis for programmatic crosshairs. An
    // empty IV scale has no first value and throws when synchronizing price.
    // Keep whitespace on a hidden scale until actual IV data owns the axis.
    view.ivAxis.applyOptions({priceScaleId:segments.length ? 'right' : 'hidden-iv'});
    view.ivAxis.setData(timeline.map(time => ({time})));
    while (view.ivSeries.length > segments.length) view.chart.removeSeries(view.ivSeries.pop());
    while (view.ivSeries.length < segments.length) view.ivSeries.push(view.chart.addSeries(LightweightCharts.LineSeries,{
      priceScaleId:'right',color:c['instrument-iv'],lineWidth:2,lineType:LightweightCharts.LineType.Simple,
      priceFormat:ivFormat,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:true,
    },0));
    view.ivAnchors.clear();
    segments.forEach((points,index) => {
      const series = view.ivSeries[index];
      series.applyOptions({color:c['instrument-iv'],pointMarkersVisible:points.length === 1,pointMarkersRadius:2});
      series.setData(points);
      points.forEach(point => view.ivAnchors.set(point.time,series));
    });
  }
  function setSeriesData(view,timeline,c) {
    view.timeline = timeline;
    setIvData(view,timeline,c);
    const point = (time,key) => M.finite(view.byTime.get(time)?.[key]) ? {time,value:view.byTime.get(time)[key]} : {time};
    view.price.setData(timeline.map(time => point(time,'price')));
    view.average.setData(timeline.map(time => point(time,'averagePrice')));
    view.volume.setData(timeline.map(time => { const item = point(time,'volume'); return 'value' in item ? {...item,color:c['series-1']} : item; }));
    view.interest.setData(view.showInterest ? timeline.map(time => point(time,'openInterest')) : []);
  }
  function alignData() {
    const c = colors();
    fitting = true;
    const revision = ++fitRevision;
    for (const view of views.values()) {
      const peer = peerOf(view);
      // Peer-only timestamps are WhitespaceData, never fabricated prices/bars.
      const ownTimes = [...view.byTime.keys(),...view.ivByTime.keys()];
      const timeline = [...new Set(paired(view,peer) ? [...ownTimes,...peer.byTime.keys(),...peer.ivByTime.keys()] : ownTimes)].sort((a,b) => a-b);
      setSeriesData(view,timeline,c);
    }
    // LWC applies layout/range changes on animation frames. Do not let a peer's
    // old/default range overwrite the initial full-day fit while those settle.
    window.requestAnimationFrame(() => {
      if (revision !== fitRevision) return;
      for (const view of views.values()) if (view.bars.length) view.chart.timeScale().fitContent();
      window.requestAnimationFrame(() => { if (revision === fitRevision) fitting = false; });
    });
  }
  function render(kind,payload,quote) {
    resetCrosshairs();
    const view = ensure(kind), c = colors();
    updating = true;
    try {
      view.quote = quote;
      view.showInterest = !(kind === 'underlying' && quote?.kind === 'ETF');
      // A dormant right-axis series would still become the volume pane's default
      // crosshair scale. Move it off that axis while ETF open interest is hidden.
      view.interest.applyOptions({visible:view.showInterest,priceScaleId:view.showInterest ? 'right' : 'hidden-interest'});
      // Keep the pane axis widget for aligned chart widths; the hidden, empty
      // interest series leaves it without labels or ticks for ETF underlyings.
      for (const suffix of ['InterestKey','SnapshotInterest']) {
        const node = $(kind + suffix);
        if (node) node.hidden = !view.showInterest;
      }
      $(kind + 'Chart').setAttribute('aria-label',`${kind === 'underlying' ? '标的' : '期权'}分钟价格、均价、成交量${view.showInterest ? '和持仓量' : ''}、${ivLabel(kind)}图`);
      view.iv = M.minuteData(payload.iv || []);
      view.ivByTime = new Map(view.iv.map(point => [point.time,point]));
      view.ivStatus = payload.ivStatus || 'no_data';
      view.bars = M.minuteData(payload.bars);
      view.byTime = new Map(view.bars.map(bar => [bar.time,bar]));
      view.bars = [...view.byTime.values()];
      view.tradingDay = payload.tradingDay || '';
      view.base = M.finite(payload.basePrice) && payload.basePrice > 0 ? payload.basePrice : null;
      const priceFormat = {type:'price',precision:M.precision(quote?.priceTick),minMove:M.finite(quote?.priceTick) && quote.priceTick > 0 ? quote.priceTick : .0001};
      view.price.applyOptions({...priceStyle(view.base,c),priceFormat});
      const precision = averagePrecision(quote?.priceTick);
      view.average.applyOptions({priceFormat:{type:'price',precision,minMove:10 ** -precision}});
      if (view.baseLine) view.price.removePriceLine(view.baseLine);
      view.baseLine = view.base ? view.price.createPriceLine({price:view.base,color:c.muted,lineWidth:1,lineStyle:LightweightCharts.LineStyle.Dashed,axisLabelVisible:false,title:payload.baseSource === 'previousSettlement' ? '昨结' : '昨收'}) : null;
      baseElement(kind).textContent = `${payload.baseSource === 'previousSettlement' ? '昨结' : payload.baseSource === 'previousClose' ? '昨收' : '基准'} ${M.price(view.base,quote?.priceTick)}`;
      $(kind + 'Empty').hidden = view.bars.some(bar => M.finite(bar.price) || M.finite(bar.averagePrice));
      $(kind + 'Empty').textContent = '该交易日暂无有效分时价格';
      alignData();
    } finally { updating = false; }
    resetCrosshairs();
  }
  function clear(kind,message) {
    resetCrosshairs();
    updating = true;
    try {
      const view = views.get(kind);
      if (view) {
        view.bars = []; view.byTime.clear(); view.iv = []; view.ivByTime.clear(); view.ivStatus = 'no_data'; view.quote = null; view.base = null; view.tradingDay = '';
        view.price.applyOptions(priceStyle(null,colors()));
        if (view.baseLine) { view.price.removePriceLine(view.baseLine); view.baseLine = null; }
        alignData();
      }
      $(kind + 'Empty').hidden = false; $(kind + 'Empty').textContent = message;
      $(kind + 'Readout').textContent = '—';
      if ($(kind + 'IvReadout')) $(kind + 'IvReadout').textContent = '—';
      baseElement(kind).textContent = '基准 —';
      snapshot(kind,null,undefined,null);
    } finally { updating = false; }
    resetCrosshairs();
  }
  function refreshChartAppearance() {
    const c = colors();
    updating = true;
    try {
      for (const view of views.values()) {
        view.chart.applyOptions(options());
        view.price.applyOptions(priceStyle(view.base,c)); view.volume.applyOptions({color:c['series-1']});
        view.average.applyOptions({color:c['oh-average']});
        setSeriesData(view,view.timeline,c);
        view.interest.applyOptions({color:c['series-4']}); view.baseLine?.applyOptions({color:c.muted});
        view.chart.priceScale('left',1).applyOptions({visible:true,borderColor:c.line});
        view.chart.priceScale('right',1).applyOptions({visible:true,borderColor:c.line});
        view.chart.priceScale('right',0).applyOptions({visible:true});
      }
    } finally { updating = false; }
    resetCrosshairs();
  }
  window.addEventListener('mqdq:themechange',refreshChartAppearance);
  // Keep canvas text in sync with asynchronously loaded font subsets.
  document.fonts?.addEventListener('loadingdone',refreshChartAppearance);
  return {render,clear,onTimeSelect(listener) { timeSelect = listener; },setReplayTime(time) {
    replayTime = M.finite(time) ? time : null;
    selectionTime = replayTime;
    selectionDay = replayTime === null ? '' : [...views.values()].find(view => view.timeline.includes(time))?.tradingDay || selectionDay;
    resetCrosshairs();
  }};
})();
