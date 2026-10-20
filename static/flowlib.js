/* 실시간 호가창·체결·고래·청산 계산 + 웹소켓 래퍼. 브라우저(전역 FL)와 Node(require) 겸용 순수 JS. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FL = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const median = a => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const sum = a => a.reduce((x, y) => x + y, 0);

  // ---- 파서
  const parseUpbitOrderbook = m => ({
    bids: m.orderbook_units.map(u => [u.bid_price, u.bid_size]),
    asks: m.orderbook_units.map(u => [u.ask_price, u.ask_size]), ts: m.timestamp});
  // ask_bid는 시장가 주문 방향: BID = 시장가 매수(테이커 매수), ASK = 시장가 매도
  const parseUpbitTrade = m => ({id: m.sequential_id, ts: m.trade_timestamp ?? m.timestamp, price: m.trade_price, qty: m.trade_volume,
    side: m.ask_bid === "BID" ? "BUY" : "SELL", snapshot: m.stream_type === "SNAPSHOT"});
  const parseBinanceDepth = m => ({bids: (m.b || []).map(([p, q]) => [+p, +q]), asks: (m.a || []).map(([p, q]) => [+p, +q])});
  // m = 매수자가 메이커 -> 시장가 매도 체결
  const parseBinanceAggTrade = m => ({id: m.a, ts: m.T, price: +m.p, qty: +m.q, side: m.m ? "SELL" : "BUY"});
  // 강제청산 주문 S=SELL은 롱 포지션이 청산된 것
  const parseBinanceForceOrder = m => {
    const o = m.o, price = +o.ap || +o.p, qty = +o.z || +o.q;
    return {ts: o.T, symbol: o.s, side: o.S, price, qty, value: price * qty};
  };

  // ---- 호가 사다리: 위에서 아래로 먼 매도 -> 가까운 매도 -> 가까운 매수 -> 먼 매수
  function ladder(bids, asks, n = 15) {
    const b = bids.slice(0, n), a = asks.slice(0, n);
    if (!b.length || !a.length) return null;
    const val = ([p, q]) => p * q;
    // 벽: 그 쪽 중앙값의 5배 이상이면서 그 쪽 전체 물량의 10% 이상(크기 편차가 큰 호가창에서 벽이 남발되지 않게)
    const walls = lv => { const v = lv.map(val), med = median(v), tot = sum(v); return v.map(x => med > 0 && x >= 5 * med && x >= 0.1 * tot); };
    const bw = walls(b), aw = walls(a);
    const max = Math.max(...b.map(val), ...a.map(val));
    const rows = (side, lv, w) => lv.map(([price, qty], i) => ({side, price, qty, value: price * qty, pct: max > 0 ? price * qty / max : 0, wall: w[i]}));
    const mid = (a[0][0] + b[0][0]) / 2, B = sum(b.map(val)), A = sum(a.map(val));
    return {asks: rows("ask", a, aw).reverse(), bids: rows("bid", b, bw), mid, spread: a[0][0] - b[0][0],
      spreadBps: (a[0][0] - b[0][0]) / mid * 1e4, imbalance: B + A > 0 ? (B - A) / (B + A) : 0};
  }

  // ---- 고래: fixed가 있으면 고정 금액, 없으면 직전 표본 중앙값 x mult (최소 floor). 기준은 이번 체결을 넣기 전 표본으로 계산한다
  class WhaleTracker {
    constructor({fixed = null, floor = 0, mult = 30, turnoverFrac = 1e-4, window = 500, keep = 20, minSamples = 30} = {}) {
      Object.assign(this, {fixed, floor, mult, turnoverFrac, window, keep, minSamples});
      this.values = []; this.all = []; this.buy = 0; this.sell = 0; this.count = 0; this.turnover = null;
    }
    setTurnover(v) {  // 24시간 거래대금(같은 통화). 처음 값이 들어올 때만 임시 기준으로 잡힌 고래를 다시 거른다
      const first = this.turnover == null;
      this.turnover = v > 0 ? v : null;
      if (!first || this.turnover == null || this.fixed != null) return;
      const th = this.threshold();
      this.all = this.all.filter(r => r.value >= th);
      this.buy = sum(this.all.filter(r => r.side === "BUY").map(r => r.value));
      this.sell = sum(this.all.filter(r => r.side !== "BUY").map(r => r.value));
      this.count = this.all.length;  // 이후에는 기록을 건드리지 않는다(500건 상한 때문에 건수가 조용히 줄지 않게)
    }
    threshold() {
      if (this.fixed != null) return this.fixed;
      // 자동: 종목 규모(24h 거래대금)의 0.01%. 아직 모르면 직전 체결 중앙값 x mult로 대신한다
      if (this.turnover != null) return Math.max(this.floor, this.turnoverFrac * this.turnover);
      return this.values.length >= this.minSamples ? Math.max(this.floor, this.mult * median(this.values)) : this.floor;
    }
    add(t) {
      const value = t.price * t.qty, th = this.threshold();
      this.values.push(value);
      if (this.values.length > this.window) this.values.shift();
      if (value < th) return null;
      const rec = {ts: t.ts, side: t.side, value, price: t.price, qty: t.qty, threshold: th};
      this.all.unshift(rec);
      if (this.all.length > 500) this.all.length = 500;
      if (t.side === "BUY") this.buy += value; else this.sell += value;
      this.count++;
      return rec;
    }
    netSince(ts) { return sum(this.all.filter(r => r.ts >= ts).map(r => r.side === "BUY" ? r.value : -r.value)); }
    summary() { return {buy: this.buy, sell: this.sell, net: this.buy - this.sell, count: this.count, list: this.all.slice(0, this.keep)}; }
  }

  // ---- 체결 테이프 + 분 단위 매수/매도 누적(CVD)
  class Tape {
    constructor({keep = 60} = {}) { this.keep = keep; this.list = []; this.buckets = new Map(); this.seen = new Set(); this.seenQ = []; }
    add(t) {
      const key = t.id != null ? "id" + t.id : `${t.ts}|${t.price}|${t.qty}|${t.side}`;  // 체결 id가 없으면 값으로 구분
      if (this.seen.has(key)) return;
      this.seen.add(key); this.seenQ.push(key);
      if (this.seenQ.length > 500) this.seen.delete(this.seenQ.shift());
      this.list.unshift(t);
      if (this.list.length > this.keep) this.list.length = this.keep;
      const m = Math.floor(t.ts / 60000), b = this.buckets.get(m) || {buy: 0, sell: 0}, v = t.price * t.qty;
      if (t.side === "BUY") b.buy += v; else b.sell += v;
      this.buckets.set(m, b);
      for (const k of this.buckets.keys()) if (k < m - 180) this.buckets.delete(k);
    }
    recent(n) { return this.list.slice(0, n); }
    cvd(now, minutes) {
      const end = Math.floor(now / 60000), out = [];
      for (let m = end - minutes + 1; m <= end; m++) { const b = this.buckets.get(m); out.push({minute: m, buy: b ? b.buy : 0, sell: b ? b.sell : 0}); }
      return out;
    }
  }

  // ---- 청산
  class Liquidations {
    constructor({keep = 30} = {}) { this.keep = keep; this.list = []; this.longs = 0; this.shorts = 0; }
    add(o) {
      const isLong = o.side === "SELL";
      this.list.unshift({...o, label: isLong ? "롱 청산" : "숏 청산"});
      if (this.list.length > this.keep) this.list.length = this.keep;
      if (isLong) this.longs += o.value; else this.shorts += o.value;
    }
    summary() { return {longs: this.longs, shorts: this.shorts, list: this.list}; }
  }

  // ---- 웹소켓 래퍼: 구독 전송, 바이너리 디코드, stale 감시(연결 시도 시점부터 staleMs 동안 메시지가 없으면 재연결), 지수 백오프
  function createStream(o) {
    const WS = o.WS || (typeof WebSocket !== "undefined" ? WebSocket : null);
    const now = o.now || Date.now;
    const T = o.timers || {setTimeout: (f, m) => setTimeout(f, m), clearTimeout: id => clearTimeout(id),
      setInterval: (f, m) => setInterval(f, m), clearInterval: id => clearInterval(id)};
    const staleMs = o.staleMs || 15000, backoff = o.backoff || [1000, 2000, 5000, 10000], status = s => o.onStatus && o.onStatus(s);
    let ws = null, started = false, closed = false, attempt = 0, lastMsg = 0, retry = null, watchdog = null;

    function stopWatchdog() { if (watchdog != null) { T.clearInterval(watchdog); watchdog = null; } }
    function scheduleRetry() {
      if (closed || retry != null) return;
      const wait = backoff[Math.min(attempt, backoff.length - 1)];
      attempt++;
      retry = T.setTimeout(() => { retry = null; if (!closed) open(); }, wait);
    }
    // 소켓을 버리고 바로 재연결 경로로 간다: close 핸드셰이크 응답(onclose)을 기다리지 않는다
    function drop(sock, why) {
      if (sock !== ws) return;
      sock.onopen = sock.onmessage = sock.onclose = null;
      try { sock.close(); } catch (e) { /* 이미 죽은 소켓 */ }
      ws = null; stopWatchdog();
      if (why) status(why);
      status("closed");
      scheduleRetry();
    }
    function open() {
      let sock;
      try { sock = new WS(o.url); } catch (e) { status("closed"); scheduleRetry(); return; }
      ws = sock;
      try { sock.binaryType = "arraybuffer"; } catch (e) { /* 일부 구현은 읽기 전용 */ }
      lastMsg = now();  // 연결 시도 시각부터 센다: CONNECTING에서 멈춰도 staleMs 뒤 재연결
      stopWatchdog();
      watchdog = T.setInterval(() => { if (now() - lastMsg >= staleMs) drop(sock, "stale"); }, 3000);
      sock.onopen = () => {
        if (sock !== ws) return;
        attempt = 0; lastMsg = now(); status("open");
        try { if (o.subscribe != null) sock.send(JSON.stringify(o.subscribe)); } catch (e) { drop(sock); }
      };
      sock.onmessage = ev => {
        lastMsg = now();
        try {
          const d = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
          o.onMessage(JSON.parse(d));
        } catch (e) { /* 해석할 수 없는 프레임은 무시 */ }
      };
      sock.onclose = () => {
        if (sock !== ws) return;
        ws = null; stopWatchdog(); status("closed"); scheduleRetry();
      };
    }
    return {
      start() { if (started) return; started = true; closed = false; open(); },
      close() {
        closed = true; started = false; stopWatchdog();
        if (retry != null) { T.clearTimeout(retry); retry = null; }
        if (ws) { const s = ws; ws = null; s.onopen = s.onmessage = s.onclose = null; try { s.close(); } catch (e) { /* 무시 */ } }
        status("closed");
      },
    };
  }

  // ---- 보유종목 고래 경보: 최근 windowMs 동안 고래 순매도가 max(기준 x mult, minNet) 이상이면 {net, threshold}, 아니면 null
  function whaleAlert(tracker, now, {windowMs = 300000, mult = 10, minNet = 3e7} = {}) {
    const net = tracker.netSince(now - windowMs), th = tracker.threshold();
    return net < 0 && -net >= Math.max(th * mult, minNet) ? {net, threshold: th} : null;
  }

  // 호가 단위가 보이게 소수 자릿수를 맞춘다(이더리움 2474.01과 2474.02가 둘 다 "2,474"로 보이면 안 된다)
  const priceDecimals = prices => Math.max(0, ...prices.map(p => {
    const t = Number(p).toFixed(8).replace(/0+$/, ""), i = t.indexOf(".");
    return i < 0 ? 0 : t.length - i - 1;
  }));
  const fmtPrice = (p, dec) => Number(p).toLocaleString("en-US", {minimumFractionDigits: dec, maximumFractionDigits: dec});

  // ---- 경보 기록: 확인(ack)할 때까지 남는다. 조건이 풀려도 "해소됨"으로 남아 다른 탭에 있던 사용자가 놓치지 않는다
  class AlertLog {
    constructor() { this.m = new Map(); }
    update(code, alert, now) {
      const e = this.m.get(code);
      if (alert) {
        if (e && e.active) { e.net = alert.net; e.threshold = alert.threshold; e.at = now; }
        else this.m.set(code, {code, net: alert.net, threshold: alert.threshold, at: now, active: true, acked: false});
      } else if (e) {
        e.active = false;
        if (e.acked) this.m.delete(code);
      }
    }
    ack(code) { const e = this.m.get(code); if (!e) return; e.acked = true; if (!e.active) this.m.delete(code); }
    pending() { return [...this.m.values()].filter(e => !e.acked); }
    drop(codes) { for (const k of [...this.m.keys()]) if (!codes.includes(k)) this.m.delete(k); }
  }

  return {median, AlertLog, priceDecimals, fmtPrice, whaleAlert, parseUpbitOrderbook, parseUpbitTrade, parseBinanceDepth, parseBinanceAggTrade, parseBinanceForceOrder,
    ladder, WhaleTracker, Tape, Liquidations, createStream};
});
