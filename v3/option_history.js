(() => {
  'use strict';
  const cfg = JSON.parse(document.getElementById('dashboardConfig').textContent);
  const M = window.OptionHistoryModel, charts = window.OptionHistoryCharts, $ = id => document.getElementById(id);
  const api = OptionHistoryApi.create({...cfg,readUserId:DashboardCommon.readUserId});
  const preferenceKey = 'optq.v3.selection.v1';
  let preferred = null;
  try { preferred = M.readPreference(localStorage.getItem(preferenceKey)); } catch {}
  const state = {requestedDay:undefined,authorized:false,sortDirection:1,catalog:null,selection:{},chain:null,quote:null,quoteItems:[],asOf:null,epoch:0,chartEpoch:0,quoteRequest:null,replayRequest:null,replayChartTime:null,requests:new Set()};
  const formatTime = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const esc = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const stamp = value => M.finite(value) ? formatTime.format(new Date(value)) : '—';
  const analyticsColumns = new Set(['impliedVol','delta','gamma','vega','theta']);
  const columns = [['symbol','合约'],['theta','Theta'],['vega','Vega'],['gamma','Gamma'],['delta','Delta'],['impliedVol','IV'],['volume','成交量'],['openInterest','持仓量'],['previousSettlement','昨结价'],['previousClose','昨收价'],['low','最低价'],['high','最高价'],['open','开盘价'],['price','收盘 / 最新']];
  $('callColumns').innerHTML = columns.map(([,label],index) => `<span${index === 0 ? ' class="oh-symbol"' : ''}>${label}</span>`).join('');
  $('putColumns').innerHTML = [...columns].reverse().map(([key,label]) => `<span${key === 'symbol' ? ' class="oh-symbol"' : ''}>${label}</span>`).join('');
  const picker = OptionHistoryPicker.create({onSelect:seriesId => {
    if (!state.catalog || !state.authorized) return;
    const selection = M.choose(state.catalog,{seriesId});
    preferred = M.preference(selection.selected);
    try { const saved = M.serializePreference(preferred); if (saved) localStorage.setItem(preferenceKey,saved); } catch {}
    // An explicit choice replaces the saved preference even when it confirms a fallback.
    if (state.selection.seriesId === selection.seriesId) return;
    state.selection = selection;
    renderSelectors(); loadChain();
  }});
  const calendar = OptionHistoryCalendar.create({onSelect:day => {
    if (state.authorized && M.availableDates(state.catalog).includes(day) && day !== state.catalog.tradingDay) loadCatalog(day);
  }});
  const access = createDashboardAccess({pageName:'期权历史行情',returnPath:'/option-history',onDenied:deny});

  function abortRequests() {
    state.epoch++; state.chartEpoch++;
    for (const controller of state.requests) controller.abort();
    state.requests.clear();
    state.quoteRequest = null;
    state.replayRequest = null;
  }
  function deny() {
    state.authorized = false; abortRequests();
    state.catalog = state.chain = state.quote = null; state.selection = {}; state.asOf = null;
    state.quoteItems = []; $('chainRows').replaceChildren();
    calendar.reset(); picker.reset();
    clearContent('请重新验证访问权限');
    $('pageNotice').hidden = true;
  }
  function clearContent(message = '正在读取期权链') {
    state.replayChartTime = null;
    charts.setReplayTime(null);
    $('replayStatus').textContent = '点击分时图回放期权链'; $('exitReplay').hidden = true;
    $('chainScroll').setAttribute('aria-busy','false');
    state.chain = null; state.quoteItems = []; $('chainRows').replaceChildren(); $('chainEmpty').hidden = false; $('chainEmpty').textContent = message;
    $('chainMeta').textContent = '按行权价排列 · 点击合约查看走势'; $('chainQuality').textContent = ''; $('locateAtm').disabled = true;
    $('underlyingSummary').innerHTML = '<div class="oh-summary-title"><span>标的行情</span><strong>—</strong></div>';
    for (const kind of ['underlying','intraday']) { charts.clear(kind,message); $(kind + 'Title').textContent = kind === 'underlying' ? '选择标的' : '选择期权合约'; }
  }
  function setNotice(message, retry = false) {
    $('pageNotice').hidden = !message; $('pageNotice').textContent = message;
    if (retry) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'oh-text-button'; button.textContent = '重新加载';
      button.addEventListener('click',() => loadCatalog(state.requestedDay,true)); $('pageNotice').append(button);
    }
  }
  function protectedError(error) {
    if (cfg.authRequired && (error.status === 401 || error.status === 403 || error.code === 'AUTH_SERVICE_UNAVAILABLE')) {
      access.show(error.code === 'AUTH_SERVICE_UNAVAILABLE' ? 503 : error.status); return true;
    }
    return false;
  }
  async function request(endpoint,params,controller) {
    state.requests.add(controller);
    try { return await api.get(endpoint,params,{signal:controller.signal}); }
    finally { state.requests.delete(controller); }
  }
  function renderSelectors() {
    calendar.setCatalog(state.catalog);
    picker.setCatalog(state.catalog,state.selection.seriesId);
  }
  async function loadCatalog(tradingDay,refresh = false) {
    if (!state.authorized) return;
    const retained = preferred || {...state.selection};
    state.requestedDay = tradingDay; abortRequests(); const epoch = state.epoch;
    const controller = new AbortController(); clearContent('正在读取历史目录'); setNotice('');
    $('refreshStatus').textContent = '正在读取数据…'; $('refresh').disabled = true;
    calendar.setDisabled(true); picker.setDisabled(true);
    try {
      let catalog = await request('catalog',{tradingDay,refresh:refresh || undefined},controller);
      if (epoch !== state.epoch || !state.authorized) return;
      let available = M.availableDates(catalog);
      // A newly opened page may receive a newer tick-only day. Start at the latest
      // day that can form a chain instead; don't offer uncovered days in the calendar.
      if (!available.includes(catalog.tradingDay) && available.length) {
        state.requestedDay = available[0];
        catalog = await request('catalog',{tradingDay:available[0],refresh:refresh || undefined},controller);
        if (epoch !== state.epoch || !state.authorized) return;
        available = M.availableDates(catalog);
      }
      if (!available.includes(catalog.tradingDay)) catalog = {...catalog,series:[]};
      state.catalog = catalog; state.asOf = catalog.asOf;
      state.requestedDay = catalog.tradingDay;
      // A temporary fallback must not replace the user's preferred underlying.
      state.selection = M.choose(catalog,retained);
      renderSelectors();
      if (!state.selection.selected) {
        const date = (catalog.dates || []).find(item => item.tradingDay === catalog.tradingDay);
        const message = !available.length ? '暂无同时具有行情和合约属性的交易日，请稍后刷新。' : date?.hasTicks && !date.hasMetadata ? '该交易日缺少合约属性，请从日历选择可用交易日。' : '该交易日暂无可用期权系列。';
        clearContent(message); setNotice(message); $('refreshStatus').textContent = '暂无期权链';
        return;
      }
      await loadChain(refresh);
    } catch (error) {
      if (controller.signal.aborted || epoch !== state.epoch) return;
      if (!protectedError(error)) { clearContent('历史目录加载失败'); setNotice(error.message || '历史目录加载失败，请稍后重试',true); $('refreshStatus').textContent = '加载失败'; }
    } finally {
      if (epoch === state.epoch) {
        $('refresh').disabled = false;
        if (state.authorized && state.catalog) renderSelectors();
      }
    }
  }
  async function loadChain(refresh = false) {
    if (!state.authorized || !state.selection.selected) return;
    abortRequests(); const epoch = state.epoch, controller = new AbortController();
    const previousQuote = state.quote ? M.identity(state.quote) : null;
    clearContent('正在读取期权链'); setNotice(''); $('refreshStatus').textContent = '正在读取期权链…';
    try {
      const chain = await request('chain',{tradingDay:state.catalog.tradingDay,seriesId:state.selection.seriesId,asOf:state.catalog.asOf,refresh:refresh || undefined},controller);
      if (epoch !== state.epoch || !state.authorized) return;
      state.chain = chain; state.asOf = chain.asOf; renderChain();
      state.quote = M.chooseQuote(chain,previousQuote);
      $('refreshStatus').textContent = chain.status === 'intraday' ? '盘中快照 · 手动刷新' : chain.status === 'closed' ? '已收市 · 历史快照' : '暂无行情';
      const underlyingRequest = loadUnderlying(refresh);
      if (state.quote) {
        const quoteRequest = selectQuote(state.quote,refresh);
        centerChainElement($('chainRows').querySelector('[data-quote][aria-pressed="true"]'));
        await Promise.all([underlyingRequest,quoteRequest]);
      }
      else { charts.clear('intraday','该系列暂无可选择的期权合约'); await underlyingRequest; }
    } catch (error) {
      if (controller.signal.aborted || epoch !== state.epoch) return;
      if (!protectedError(error)) { clearContent('期权链加载失败'); setNotice(error.message || '期权链加载失败',true); $('refreshStatus').textContent = '加载失败'; }
    } finally { if (epoch === state.epoch) $('refresh').disabled = false; }
  }
  async function replayChain({time,tradingDay,replayAt: snapshotAt}) {
    if (!state.authorized || !state.chain || tradingDay !== state.chain.tradingDay || !M.finite(time)) return;
    const replayAt = Math.min(Math.round(M.finite(snapshotAt) ? snapshotAt : time * 1000),state.asOf);
    if (!state.replayRequest && state.chain.replayAt === replayAt) return;
    state.replayRequest?.abort();
    const controller = new AbortController(), epoch = state.epoch;
    state.replayRequest = controller;
    $('replayStatus').textContent = `正在回放 ${stamp(replayAt)}…`; $('exitReplay').hidden = false;
    $('chainScroll').setAttribute('aria-busy','true'); setNotice('');
    try {
      const chain = await request('chain',{tradingDay,seriesId:state.selection.seriesId,asOf:state.catalog.asOf,replayAt},controller);
      if (controller.signal.aborted || epoch !== state.epoch || state.replayRequest !== controller || !state.authorized) return;
      const selected = state.quote && M.identity(state.quote);
      state.chain = chain; state.quote = M.chooseQuote(chain,selected);
      state.replayChartTime = time;
      renderChain(true);
      charts.setReplayTime(time);
      $('refreshStatus').textContent = `回放 · ${stamp(replayAt)}`;
    } catch (error) {
      if (controller.signal.aborted || epoch !== state.epoch || state.replayRequest !== controller) return;
      if (!protectedError(error)) {
        charts.setReplayTime(state.chain?.replayAt ? state.replayChartTime : null);
        $('replayStatus').textContent = state.chain?.replayAt ? `回放 ${stamp(state.chain.replayAt)}` : '点击分时图回放期权链';
        $('exitReplay').hidden = !state.chain?.replayAt;
        setNotice('回放加载失败，已保留原快照，请重新点击时间点。');
      }
    } finally {
      if (state.replayRequest === controller) { state.replayRequest = null; $('chainScroll').setAttribute('aria-busy','false'); }
    }
  }
  function renderUnderlying() {
    const u = state.chain.underlying, series = state.chain.series;
    const title = !u ? '标的行情' : u.kind === 'FUTURE' ? u.exchange === 'CFFEX' ? '期货参考标的' : '期货标的' : 'ETF 标的';
    const direction = M.finite(u?.changePct) ? u.changePct > 0 ? 'oh-up' : u.changePct < 0 ? 'oh-down' : '' : '';
    const cells = [
      [title,u?.name || u?.symbol || series?.underlyingSymbol || '—','oh-summary-title'],
      [u?.priceSource === 'last' ? '最新价' : '收盘价',M.number(u?.price,6)],
      ['涨跌幅 · 昨收',M.finite(u?.changePct) ? `${u.changePct > 0 ? '+' : ''}${u.changePct.toFixed(2)}%` : '—',direction],
      ['最高价',M.number(u?.high,6)],['最低价',M.number(u?.low,6)],['成交量',M.number(u?.volume,2)],
    ];
    $('underlyingSummary').innerHTML = cells.map(([label,value,className = '']) => `<div class="${className}"><span>${esc(label)}</span><strong>${esc(value)}</strong>${className === 'oh-summary-title' ? `<span>行情 ${esc(stamp(u?.dataTime))}</span>` : ''}</div>`).join('');
  }
  function quoteLeg(quotes,side) {
    if (!quotes?.length) return '<div class="oh-quote-empty">—</div>';
    const fields = side === 'call' ? columns : [...columns].reverse();
    return quotes.map(quote => {
      const index = state.quoteItems.push(quote) - 1;
      const cells = fields.map(([key]) => {
        const analytics = analyticsColumns.has(key), calculated = quote.analytics?.[key];
        const value = analytics ? M.analyticsValue(key,calculated?.value) : key === 'symbol' ? quote.symbol : ['volume','openInterest'].includes(key) ? M.number(quote[key],2) : M.price(quote[key],quote.priceTick);
        const title = analytics ? value === '—' ? '' : stamp(calculated?.time) : null;
        return `<span data-column="${key}" class="${key === 'symbol' ? 'oh-symbol' : key === 'price' ? 'oh-quote-price' : ''}"${title !== null ? ` title="${esc(title)}"` : ''}>${esc(value)}</span>`;
      }).join('');
      return `<button type="button" class="oh-quote-grid oh-${side}" data-quote="${index}" aria-pressed="false" aria-label="查看${side === 'call' ? '认购' : '认沽'} ${esc(quote.symbol)} 走势" title="${esc(stamp(quote.dataTime))}">${cells}</button>`;
    }).join('');
  }
  function renderChain(preserveScroll = false) {
    const scrollTop = $('chainScroll').scrollTop;
    const scrollLeft = Object.fromEntries(['call','put'].map(side => [side,document.querySelector(`[data-scroll-side="${side}"]`)?.scrollLeft || 0]));
    const chain = state.chain, atm = M.nearestStrike(chain); state.quoteItems = [];
    renderUnderlying();
    const priceLabel = chain.replayAt ? '回放价' : chain.status === 'intraday' ? '最新价' : '收盘 / 末价';
    $('callColumns').lastElementChild.textContent = priceLabel; $('putColumns').firstElementChild.textContent = priceLabel;
    const count = M.quotes(chain).length;
    $('chainRows').innerHTML = (chain.rows || []).slice().sort((a,b) => state.sortDirection * (a.strikePrice - b.strikePrice)).map(row => `<tr${row.strikePrice === atm ? ' class="oh-atm"' : ''}><td><div class="oh-leg-viewport" data-scroll-side="call">${quoteLeg(row.calls,'call')}</div></td><th scope="row" class="oh-strike">${esc(M.number(row.strikePrice,8))}${row.strikePrice === atm ? '<small>近似平值</small>' : ''}</th><td><div class="oh-leg-viewport" data-scroll-side="put">${quoteLeg(row.puts,'put')}</div></td></tr>`).join('');
    for (const side of ['call','put']) syncLegScroll(side,preserveScroll ? scrollLeft[side] : side === 'call' ? Infinity : 0);
    if (preserveScroll) $('chainScroll').scrollTop = scrollTop;
    document.querySelectorAll('[data-quote]').forEach(button => button.setAttribute('aria-pressed',String(state.quote && M.identity(state.quoteItems[Number(button.dataset.quote)]) === M.identity(state.quote))));
    $('replayStatus').textContent = chain.replayAt ? `回放 ${stamp(chain.replayAt)}` : '点击分时图回放期权链';
    $('exitReplay').hidden = !chain.replayAt;
    $('chainEmpty').hidden = count > 0; $('chainEmpty').textContent = '该系列当日暂无期权合约';
    $('chainMeta').textContent = `${chain.tradingDay} · 到期 ${chain.series.expiry} · ${count} 个合约 · 行情 ${stamp(chain.dataTime)}`;
    $('locateAtm').disabled = atm === null;
    // A contract without an earlier quote stays blank; don't warn for the whole chain.
    $('chainQuality').textContent = M.qualityText([...(chain.quality || []),...(chain.underlying?.quality || [])]
      .filter(code => code !== 'quote_missing' && code !== 'price_missing'));
  }
  async function loadUnderlying(refresh = false) {
    const epoch = state.epoch, chain = state.chain, series = chain.series, underlying = chain.underlying;
    const identity = {
      sourceChannel:underlying?.sourceChannel || series.sourceChannel,
      exchange:underlying?.exchange || series.underlyingExchange,
      symbol:underlying?.symbol || series.underlyingSymbol,
      kind:underlying?.kind || (['SSE','SZSE'].includes(series.underlyingExchange) ? 'ETF' : 'FUTURE'),
      // An option's price tick does not describe its underlying instrument.
      priceTick:underlying?.priceTick ?? null,
    };
    const name = underlying?.name && underlying.name !== identity.symbol ? `${underlying.name} · ` : '';
    const reference = identity.exchange === 'CFFEX' && !name.includes('参考期货') ? ' · 参考期货' : '';
    $('underlyingTitle').textContent = `${name}${identity.symbol || '标的'}${reference}`;
    charts.clear('underlying','正在读取标的分时…');
    if (!identity.symbol) {
      charts.clear('underlying','缺少标的合约信息'); return;
    }
    const controller = new AbortController();
    try {
      const {sourceChannel,exchange,symbol} = identity;
      const payload = await request('intraday',{sourceChannel,exchange,symbol,seriesId:series.id,tradingDay:chain.tradingDay,asOf:chain.asOf,refresh:refresh || undefined},controller);
      if (controller.signal.aborted || epoch !== state.epoch || !state.authorized) return;
      charts.render('underlying',payload,identity);
    } catch (error) {
      if (controller.signal.aborted || epoch !== state.epoch) return;
      if (!protectedError(error)) charts.clear('underlying','标的分时加载失败，请点击顶部刷新重试');
    }
  }
  async function selectQuote(quote,refresh = false) {
    if (!state.authorized || !state.chain || !quote) return;
    state.chartEpoch++; const chartEpoch = state.chartEpoch, epoch = state.epoch;
    // Switching Call/Put must not cancel or reload the shared underlying chart.
    state.quoteRequest?.abort();
    state.quote = quote;
    document.querySelectorAll('[data-quote]').forEach(button => button.setAttribute('aria-pressed',String(M.identity(state.quoteItems[Number(button.dataset.quote)]) === M.identity(quote))));
    const label = `${quote.optionType === 'C' ? '认购' : '认沽'} ${quote.symbol} · 行权 ${M.number(quote.strikePrice,8)}`;
    $('intradayTitle').textContent = label; charts.clear('intraday','正在读取期权分时…');
    const base = {sourceChannel:quote.sourceChannel,exchange:quote.exchange,symbol:quote.symbol,seriesId:state.chain.series.id,asOf:state.asOf,refresh:refresh || undefined};
    const controller = new AbortController(); state.quoteRequest = controller;
    try {
      const payload = await request('intraday',{...base,tradingDay:state.chain.tradingDay},controller);
      if (controller.signal.aborted || epoch !== state.epoch || chartEpoch !== state.chartEpoch || !state.authorized) return;
      charts.render('intraday',payload,quote);
    } catch (error) {
      if (controller.signal.aborted || epoch !== state.epoch || chartEpoch !== state.chartEpoch) return;
      if (!protectedError(error)) charts.clear('intraday','期权分时加载失败，请点击顶部刷新重试');
    } finally { if (state.quoteRequest === controller) state.quoteRequest = null; }
  }
  function syncLegScroll(side,left) {
    document.querySelectorAll(`[data-scroll-side="${side}"]`).forEach(element => {
      const target = left === Infinity ? element.scrollWidth - element.clientWidth : left;
      if (Math.abs(element.scrollLeft - target) > 1) element.scrollLeft = target;
    });
  }
  function centerChainElement(element) {
    if (!element) return;
    const scroll = $('chainScroll'), bounds = scroll.getBoundingClientRect();
    const headerHeight = scroll.querySelector('thead').getBoundingClientRect().height;
    const target = element.getBoundingClientRect();
    // Center within the visible rows below the sticky header, without moving the page.
    const center = bounds.top + scroll.clientTop + headerHeight + (scroll.clientHeight - headerHeight) / 2;
    scroll.scrollTop += target.top + target.height / 2 - center;
  }
  $('chainScroll').addEventListener('scroll',event => { const side = event.target.dataset?.scrollSide; if (side) syncLegScroll(side,event.target.scrollLeft); },true);
  window.addEventListener('resize',() => { syncLegScroll('call',Infinity); syncLegScroll('put',0); });
  $('refresh').addEventListener('click',() => loadCatalog(state.catalog?.tradingDay,true));
  charts.onTimeSelect(replayChain);
  $('exitReplay').addEventListener('click',() => loadChain(true));
  $('chainRows').addEventListener('click',event => { const button = event.target.closest('[data-quote]'); if (button) selectQuote(state.quoteItems[Number(button.dataset.quote)]); });
  $('sortStrike').addEventListener('click',() => {
    state.sortDirection *= -1; $('strikeHeading').setAttribute('aria-sort',state.sortDirection === 1 ? 'ascending' : 'descending');
    $('sortStrike').textContent = `行权价 ${state.sortDirection === 1 ? '↑' : '↓'}`;
    $('sortStrike').setAttribute('aria-label',state.sortDirection === 1 ? '行权价升序，点击降序' : '行权价降序，点击升序');
    if (state.chain) { renderChain(); document.querySelectorAll('[data-quote]').forEach(button => button.setAttribute('aria-pressed',String(state.quote && M.identity(state.quoteItems[Number(button.dataset.quote)]) === M.identity(state.quote)))); }
  });
  $('locateAtm').addEventListener('click',() => centerChainElement($('chainRows').querySelector('.oh-atm')));
  window.addEventListener('storage',event => { if (event.key === 'user' || event.key === 'uid' || event.key === null) bootstrapAccess(); });
  window.addEventListener('pagehide',() => abortRequests());
  window.addEventListener('pageshow',event => { if (event.persisted) bootstrapAccess(); });
  let accessGeneration = 0;
  async function bootstrapAccess() {
    const generation = ++accessGeneration; deny();
    await access.check({authRequired:cfg.authRequired,readUserId:DashboardCommon.readUserId,isCurrent:() => generation === accessGeneration,verify:() => api.get('access'),onGranted:() => {state.authorized = true; loadCatalog();}});
  }
  bootstrapAccess();
})();
