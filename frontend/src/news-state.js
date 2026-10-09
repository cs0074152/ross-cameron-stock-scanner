export function safeNewsUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !host.includes('.') || host.endsWith('.') || /[\[\]:]/.test(host) || /^\d+(\.\d+){3}$/.test(host) || /(^|\.)(localhost|local|internal|test|invalid|lan|home|arpa)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

export function newsTimeLabel(item) {
  if (item.timeStatus === 'future') return '时间异常';
  if (item.timeStatus === 'unknown') return '时间未知';
  return item.timeStatus === 'older' ? '超过7天 · 较早记录' : '近7天';
}

// A session belongs to exactly one market/symbol. Disposal invalidates even fetches
// whose implementations ignore AbortSignal, including timeout and visibility races.
export function createNewsSession({ apiBase, market, symbol, onState, fetchImpl = globalThis.fetch, clock = Date.now, timers = globalThis, visible = true }) {
  let disposed = false, active = visible, generation = 0, controller, busy = false;
  let scheduled, deadline, cooldown, data = null, error = null, nextManualAt = 0, polls = 0;
  const clear = name => timers.clearTimeout(name);
  const emit = () => { if (!disposed) onState({ data, error, loading: busy, retrySeconds: Math.max(0, Math.ceil((nextManualAt - clock()) / 1000)) }); };
  function tick() {
    clear(cooldown);
    if (!active || disposed) return;
    emit();
    if (nextManualAt > clock()) cooldown = timers.setTimeout(tick, 1000);
  }
  function cancel() {
    generation++;
    controller?.abort();
    clear(scheduled); clear(deadline); clear(cooldown);
    busy = false;
  }
  function schedule(ms, poll = false) {
    clear(scheduled);
    if (active && !disposed) scheduled = timers.setTimeout(() => request(false, poll), ms);
  }
  async function request(force = false, poll = false) {
    if (disposed || !active || busy || (force && clock() < nextManualAt)) return false;
    clear(scheduled);
    if (!poll) polls = 0;
    if (force) nextManualAt = clock() + 15000;
    busy = true; error = null;
    controller = new AbortController();
    const signal = controller.signal, token = ++generation;
    emit(); tick();
    try {
      const timeout = new Promise((_, reject) => {
        deadline = timers.setTimeout(() => {
          controller.abort();
          reject(new Error('核查请求超时，请稍后重试。'));
        }, 8000);
      });
      const result = await Promise.race([ (async () => {
        const response = await fetchImpl(`${apiBase}/api/news/${encodeURIComponent(symbol)}?market=${encodeURIComponent(market)}${force ? '&refresh=1' : ''}`, { signal });
        if (disposed || !active || token !== generation || signal.aborted) throw new Error('核查已取消。');
        if (!response.ok) {
          if (response.status === 429) {
            const retry = response.headers?.get('Retry-After');
            const seconds = /^\d+$/.test(retry || '') ? Number(retry) : Math.max(0, (Date.parse(retry) - clock()) / 1000);
            if (Number.isFinite(seconds)) nextManualAt = Math.max(nextManualAt, clock() + Math.max(15, seconds) * 1000);
            throw new Error('核查请求较频繁，请稍后重试。');
          }
          throw new Error('核查服务暂时不可用，请稍后重试。');
        }
        const body = await response.json();
        if (body.market !== market || body.symbol !== symbol || !['found', 'none', 'unavailable'].includes(body.status) || !Array.isArray(body.items) || !Array.isArray(body.sources)) throw new Error('核查服务返回的数据不匹配，请重试。');
        return body;
      })(), timeout ]);
      if (disposed || !active || token !== generation) return false;
      data = result;
    } catch (cause) {
      if (disposed || !active || token !== generation) return false;
      error = cause.message || '核查请求失败，请重试。';
    } finally {
      if (!disposed && active && token === generation) {
        clear(deadline); busy = false; emit(); tick();
        if (!error && data?.refreshing && polls < 4) { polls++; schedule(2000, true); }
        else schedule(300000);
      }
    }
    return true;
  }
  if (active) schedule(150);
  return {
    refresh: () => request(true),
    setVisible(value) {
      if (disposed || active === value) return;
      active = value; cancel();
      emit();
      if (active) { schedule(150); tick(); }
    },
    dispose() { disposed = true; cancel(); }
  };
}
