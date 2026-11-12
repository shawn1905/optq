(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OptionHistoryApi = api;
})(globalThis, () => {
  'use strict';
  class ApiError extends Error {
    constructor(status, message, code = '') { super(message); this.status = status; this.code = code; }
  }
  function create({apiBase = '/option-history', authRequired = true, readUserId = () => '', fetcher = globalThis.fetch, timeoutMs = 20000} = {}) {
    async function get(endpoint, params = {}, {signal} = {}) {
      const query = new URLSearchParams();
      for (const [key,value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key,String(value));
      const headers = {Accept:'application/json'}, user = readUserId();
      if (authRequired && user) headers['New-Api-User'] = user;
      const controller = new AbortController(); let timedOut = false;
      const cancel = () => controller.abort();
      if (signal?.aborted) cancel(); else signal?.addEventListener('abort',cancel,{once:true});
      const timer = setTimeout(() => { timedOut = true; controller.abort(); },timeoutMs); timer.unref?.();
      try {
        const response = await fetcher(`${apiBase}/api/v1/${endpoint}${query.size ? '?' + query : ''}`, {headers,credentials:'same-origin',cache:'no-store',signal:controller.signal});
        let payload;
        try { payload = await response.json(); }
        catch (error) { if (controller.signal.aborted) throw error; if (response.ok) throw new ApiError(502,'行情响应格式无效'); }
        if (!response.ok) {
          const detail = payload?.detail;
          throw new ApiError(response.status, typeof detail === 'string' ? detail : detail?.message || payload?.message || '行情服务暂时不可用', detail?.code || payload?.code || '');
        }
        if (endpoint !== 'access' && (payload?.schemaVersion !== `option-history-${endpoint}-v1` || !Number.isFinite(payload?.asOf))) throw new ApiError(502,'行情响应版本或时间无效');
        return payload;
      } catch (error) {
        if (timedOut) throw new ApiError(503,'行情查询超时，请重试');
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort',cancel); }

    }
    return {get};
  }
  return {create,ApiError};
});
