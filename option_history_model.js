/* Pure presentation rules. Contract identity and series membership come from the server. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OptionHistoryModel = api;
})(globalThis, () => {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const identity = quote => quote.symbol;
  const underlyingKey = series => JSON.stringify([series.underlyingSymbol]);
  const number = (value, digits = 4) => finite(value) ? new Intl.NumberFormat('en-US', {maximumFractionDigits:digits}).format(value) : '—';
  function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
  }
  function availableDates(catalog) {
    const dates = Array.isArray(catalog?.dates) ? catalog.dates : [];
    return [...new Set(dates.filter(item => item?.hasTicks === true && item?.hasMetadata === true && validDate(item.tradingDay))
      .map(item => item.tradingDay))].sort().reverse();
  }
  function normalizePreference(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.targetKey !== 'string'
      || value.targetKey.length > 256 || !validDate(value.expiry) || !Number.isSafeInteger(value.multiplier) || value.multiplier <= 0) return null;
    let parts;
    try { parts = JSON.parse(value.targetKey); } catch (_) { return null; }
    if (!Array.isArray(parts) || ![1,3].includes(parts.length) || parts.some(part => typeof part !== 'string')) return null;
    if (parts.length === 3) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(parts[0]) || !/^[A-Z]{2,12}$/.test(parts[1])) return null;
      parts = [parts[2]]; // Upgrade saved version-1 preferences.
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(parts[0])) return null;
    return {targetKey:JSON.stringify(parts),expiry:value.expiry,multiplier:value.multiplier};
  }
  function preference(series) {
    if (!series || typeof series !== 'object' || Array.isArray(series)) return null;
    return normalizePreference({targetKey:underlyingKey(series),expiry:series.expiry,multiplier:series.multiplier});
  }
  function serializePreference(value) {
    const preferred = normalizePreference(value);
    return preferred ? JSON.stringify({version:1,...preferred}) : null;
  }
  function readPreference(rawString) {
    if (typeof rawString !== 'string' || rawString.length > 2048) return null;
    try {
      const value = JSON.parse(rawString);
      return value?.version === 1 ? normalizePreference(value) : null;
    } catch (_) { return null; }
  }
  function precision(tick) {
    if (!finite(tick) || tick <= 0) return 4;
    for (let digits = 0; digits <= 8; digits++) if (Math.abs(tick * 10 ** digits - Math.round(tick * 10 ** digits)) < 1e-7) return digits;
    return 8;
  }
  function price(value, tick) {
    return finite(value) ? value.toFixed(precision(tick)) : '—';
  }
  function targets(catalog) {
    const products = new Map((catalog.products || []).map(product => [product.id,product]));
    const groups = new Map();
    for (const series of catalog.series || []) {
      const key = underlyingKey(series), product = products.get(series.productKey);
      if (!groups.has(key)) groups.set(key,{
        key,name:product?.name || product?.productId || series.underlyingSymbol,
        symbol:series.underlyingSymbol,exchange:series.underlyingExchange,
        channel:series.sourceChannel || '',referenceFuture:series.underlyingExchange === 'CFFEX',series:[],searchTerms:[],
      });
      const group = groups.get(key); group.series.push(series);
      group.searchTerms.push(product?.name || '',product?.productId || '',series.underlyingSymbol,series.underlyingExchange);
    }
    return [...groups.values()];
  }
  function choose(catalog, previous = {}) {
    previous = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {};
    const saved = normalizePreference(previous);
    if (saved) previous = {...previous,...saved};
    const groups = targets(catalog);
    const retained = typeof previous.seriesId === 'string' && previous.seriesId
      ? (catalog.series || []).find(series => series.id === previous.seriesId) : null;
    const requestedGroup = groups.find(item => item.key === (retained ? underlyingKey(retained) : previous.targetKey));
    const group = requestedGroup || groups[0];
    if (!group) return {targets:groups,targetKey:'',selected:null,seriesId:'',expiry:'',multiplier:null};
    // Server order contains the preferred series with actual ticks. Preserve a valid
    // exact series first, then the same underlying; never infer a future from a month.
    const expiry = requestedGroup && group.series.some(series => series.expiry === previous.expiry) ? previous.expiry : group.series[0].expiry;
    const matches = group.series.filter(series => series.expiry === expiry);
    const selected = retained || (requestedGroup && matches.find(series => series.multiplier === previous.multiplier)) || matches[0];
    return {targets:groups,targetKey:group.key,selected,seriesId:selected.id,expiry:selected.expiry,multiplier:selected.multiplier};
  }
  function quotes(chain) {
    return (chain?.rows || []).flatMap(row => [...(row.calls || []), ...(row.puts || [])]);
  }
  function nearestStrike(chain) {
    if (!finite(chain?.underlying?.price)) return null;
    return (chain.rows || []).filter(row => finite(row.strikePrice)).reduce((best, row) => best === null || Math.abs(row.strikePrice - chain.underlying.price) < Math.abs(best - chain.underlying.price) ? row.strikePrice : best, null);
  }
  function chooseQuote(chain, previous) {
    const all = quotes(chain), available = all.filter(quote => finite(quote.price) && finite(quote.dataTime));
    const retained = available.find(quote => identity(quote) === previous);
    if (retained) return retained;
    const spot = chain?.underlying?.price;
    if (available.length) return available.slice().sort((left,right) =>
      (finite(spot) ? Math.abs(left.strikePrice - spot) - Math.abs(right.strikePrice - spot) : 0)
      || (left.optionType === 'C' ? -1 : 1) - (right.optionType === 'C' ? -1 : 1))[0];
    // A contract with no quote today can still have historical bars.
    return all.find(quote => identity(quote) === previous) || all[0] || null;
  }
  const qualityLabels = {
    missing_baseline:'缺少成交量基线，相关分钟量未知',
    sampling_gap:'行情更新有间隔，累计增量计入后续 tick 所在分钟',
    ohlc_from_ticks:'开高低由已保存 tick 计算',
    using_last_price:'收盘价缺失，使用最后有效价',
    price_missing:'缺少有效价格',
    quote_missing:'合约没有可用行情',
    volume_missing:'成交量未知',
    reference_future:'标的使用对应期货合约作为参考',
    no_data:'查询范围内没有数据',
    session_break:'跨交易时段，保留有效累计成交量差分',
    session_break_volume_unknown:'正常休市跨段，相关分钟成交量未知',
    invalid_volume:'累计成交量无效，相关分钟量未知',
    metadata_missing:'部分历史缺少当日合约属性，仅展示原始行情',
    missing_metadata:'缺少当日合约属性',
    missing_underlying:'标的行情缺失',
    underlying_missing:'标的行情缺失',
    volume_baseline_missing:'首笔成交量基线缺失',
    volume_reset:'累计成交量回退，相关分钟量未知',
    volume_gap:'采样缺口，相关分钟成交量未知',
    sample_gap:'存在采样缺口',
    average_price_counter_reset:'累计成交额或成交量回退，后续当日均价无法计算',
    average_price_multiplier_missing:'缺少当日合约乘数，均价无法计算',
    average_price_volume_missing:'部分分钟累计成交量无效，均价缺失',
    average_price_turnover_missing:'部分分钟累计成交额无效，均价缺失',
    average_price_no_trades:'部分分钟尚无成交，均价缺失',
    average_price_invalid:'部分分钟均价计算结果无效',
    incomplete_day:'该交易日数据不完整',
    partial:'交易日尚未结束',
    close_missing:'缺少收盘价，使用最后有效价',
    last_price_fallback:'收盘价缺失，使用最后有效价',
    option_analytics_unavailable:'IV / Greeks 暂不可用，请刷新重试',
  };
  function qualityText(items = []) {
    const list = [...new Set(items.map(item => typeof item === 'string' ? item : item?.code).filter(Boolean))];
    return list.map(code => qualityLabels[code] || '数据存在缺项').filter((value,index,all) => all.indexOf(value) === index).join('；');
  }
  function dailyData(bars = []) {
    // Whitespace points preserve missing observations instead of fabricating zero prices.
    return bars.map(bar => ({...bar, time:bar.time})).filter(bar => /^\d{4}-\d{2}-\d{2}$/.test(bar.time)).sort((a,b) => a.time.localeCompare(b.time));
  }
  // A calculation cycle is five seconds. Split on explicit nulls AND missing
  // cycles: line-series whitespace alone would connect across a data gap.
  function ivSegments(points = []) {
    const segments = []; let segment = null, previous = null;
    for (const point of minuteData(points)) {
      if (!finite(point.value) || point.value <= 0) { segment = null; previous = point.time; continue; }
      if (!segment || point.time - previous > 120) { segment = []; segments.push(segment); }
      segment.push({time:point.time,value:point.value * 100});
      previous = point.time;
    }
    return segments;
  }
  function minuteData(bars = []) {
    return bars.filter(bar => finite(bar.time)).slice().sort((a,b) => a.time - b.time);
  }
  function analyticsValue(metric,value) {
    if (!finite(value) || Math.abs(value) > 1e20) return '—';
    if (metric === 'impliedVol') return value > 0 ? `${(value * 100).toFixed(2)}%` : '—';
    const decimals = metric === 'gamma' ? 6 : metric === 'delta' ? 4 : 2;
    return value !== 0 && Math.abs(value) < 10 ** -decimals ? value.toExponential(2) : value.toFixed(decimals);
  }
  return {finite,identity,underlyingKey,availableDates,preference,serializePreference,readPreference,number,price,precision,targets,choose,quotes,nearestStrike,chooseQuote,qualityText,dailyData,minuteData,ivSegments,analyticsValue};
});
