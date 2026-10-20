// 서버(app.py)의 /api/* 를 브라우저 안에서 대신 처리한다: 업비트·바이낸스 공개 API를 직접 호출하고,
// 보유종목·관심종목·그린 선은 localStorage에 저장한다. 전역 HC_API.api(url, method, body)는 dashboard.html의 api()와 같은 계약.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./rules.js"), require("./ind.js"), require("./scan.js"));
  else root.HC_API = factory(root.HC_RULES, root.HC_IND, root.HC_SCAN);
})(typeof self !== "undefined" ? self : this, function (R, IND, SC) {
  const UP = "https://api.upbit.com/v1", BN = "https://fapi.binance.com";
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const nowSec = () => Date.now() / 1000;
  const tradingDay = () => new Date().toISOString().slice(0, 10);  // 업비트 일봉은 09:00 KST(=00:00 UTC)에 바뀐다
  const CHART_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
  const UPBIT_PATH = {"1m": "minutes/1", "5m": "minutes/5", "15m": "minutes/15", "1h": "minutes/60", "4h": "minutes/240", "1d": "days"};
  const INTERVAL_MS = {"1h": 3600e3, "4h": 4 * 3600e3, "1d": 24 * 3600e3};
  const ORDER_USD = 10000;

  class RateLimited extends Error {}

  // ---- 저장소: localStorage가 막힌 환경에서도 메모리로 동작
  const mem = {};
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? (k in mem ? mem[k] : d) : JSON.parse(v); } catch { return k in mem ? mem[k] : d; } },
    set(k, v) { mem[k] = v; try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장 불가: 이번 세션 메모리에만 */ } },
  };
  const nextId = () => { const n = store.get("hc2_seq", 0) + 1; store.set("hc2_seq", n); return n; };

  // ---- 속도 제한(weight 단위). 동시 호출은 허용하고 총 처리량만 제한한다
  class Limiter {
    constructor(perSec) { this.perSec = perSec; this.nextFree = 0; }
    pause(sec) { this.nextFree = Math.max(this.nextFree, Date.now() + sec * 1000); }
    async acquire(weight = 1) {
      const now = Date.now(), start = Math.max(now, this.nextFree);
      this.nextFree = start + weight / this.perSec * 1000;
      if (start > now) await sleep(start - now);
    }
  }
  const upLimiter = new Limiter(8), bnLimiter = new Limiter(28), bnData = new Limiter(3);
  const abort = {on: false};  // 켜지면 바이낸스 요청을 더 보내지 않는다

  // 업비트 REST는 웹 출처(github.io)에서 분당 10회로 막혀 있어, 배포 환경에서는 Cloudflare Worker 프록시(worker/upbit-proxy.js)를 거친다.
  // 주소: config.js의 HC_CONFIG.upbitProxy, 또는 한 번 열어 저장하는 ?proxy=https://...workers.dev
  const isLocal = typeof location === "undefined" || ["localhost", "127.0.0.1"].includes(location.hostname);
  try { const q = new URLSearchParams(location.search).get("proxy"); if (q) localStorage.setItem("hc_proxy", q); } catch { /* 저장 불가 */ }
  let proxy = "";
  try { proxy = localStorage.getItem("hc_proxy") || ""; } catch { /* 무시 */ }
  proxy = (proxy || (root.HC_CONFIG && root.HC_CONFIG.upbitProxy) || "").replace(/\/+$/, "");

  const qs = p => p ? "?" + new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([, v]) => v != null))) : "";
  async function netFetch(url, who) {
    try { return await fetch(url); } catch { throw new Error(`${who}에 연결하지 못했습니다(네트워크 또는 접속 제한). 잠시 뒤 다시 시도하세요`); }
  }
  async function upGet(path, params) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await upLimiter.acquire(1);
      if (!proxy && !isLocal) throw new Error("업비트 시세는 웹사이트에서 직접 호출할 수 없습니다(업비트 제한). 프록시 주소를 설정하세요: 주소 끝에 ?proxy=https://(내 Worker 주소) 를 붙여 한 번 여세요");
      const r = await netFetch(`${proxy || UP}/${path}${qs(params)}`, "업비트");
      if (r.status === 429) { const w = 2 ** attempt; upLimiter.pause(w); await sleep(w * 1000); continue; }
      if (!r.ok) throw new Error(`업비트 ${r.status}`);
      return r.json();
    }
    throw new Error("업비트 요청 한도(429)가 반복됩니다. 잠시 뒤 다시 시도하세요");
  }
  async function bnGet(path, params, weight = 1, limiter = bnLimiter, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (abort.on) throw new RateLimited("스캔이 중단되어 요청을 보내지 않습니다");
      await limiter.acquire(weight);
      const r = await netFetch(BN + path + qs(params), "바이낸스");
      if (r.status === 418) throw new RateLimited("바이낸스가 이 IP를 일시 차단했습니다(418). 잠시 뒤 다시 시도하세요");
      if (r.status === 429) {
        const w = Math.min(Math.max(parseFloat(r.headers.get("Retry-After")) || 2 ** attempt, 1), 60);
        limiter.pause(w); await sleep(w * 1000); continue;
      }
      if (!r.ok) throw new Error(`바이낸스 ${r.status}`);
      return r.json();
    }
    throw new RateLimited("바이낸스 요청 한도(429)가 반복됩니다. 잠시 뒤 다시 시도하세요");
  }

  // ---- 업비트 (sources.py Upbit)
  const parseCandles = rows => rows.slice().reverse().map(r => ({ts: r.candle_date_time_kst.slice(0, 10), open: r.opening_price, high: r.high_price,
    low: r.low_price, close: r.trade_price, volume: r.candle_acc_trade_volume ?? 0}));
  async function upPages(path, symbol, count) {
    const rows = [];
    while (rows.length < count) {  // 1회 최대 200개: 더 필요하면 가장 오래된 봉 이전 구간을 이어 받는다
      const n = Math.min(200, count - rows.length), page = await upGet(`candles/${path}`, {market: symbol, count: n, to: rows.length ? rows.at(-1).candle_date_time_utc + "Z" : null});
      rows.push(...page);
      if (page.length < n) break;
    }
    return rows;
  }
  const dailyCache = new Map();  // 마감 봉만 쓰는 판정용: 거래일이 바뀔 때까지 재사용
  async function upDaily(sym, count = 200, fresh = false) {
    const c = dailyCache.get(sym), day = tradingDay();
    if (!fresh && c && c.day === day && c.count >= count) return c.rows;
    const rows = parseCandles(await upPages("days", sym, count));
    dailyCache.set(sym, {day, count, rows});
    return rows;
  }
  async function upChart(sym, interval, count = 400) {
    if (!UPBIT_PATH[interval]) throw new Error("시간봉은 1m·5m·15m·1h·4h·1d 중에서 고르세요");
    const rows = await upPages(UPBIT_PATH[interval], sym, count);
    const t = interval === "1d" ? r => r.candle_date_time_kst.slice(0, 10) : r => Math.floor(Date.parse(r.candle_date_time_utc + "Z") / 1000);
    return rows.reverse().map(r => ({time: t(r), open: r.opening_price, high: r.high_price, low: r.low_price, close: r.trade_price, value: r.candle_acc_trade_volume ?? 0}));
  }
  const upPrice = async sym => +(await upGet("ticker", {markets: sym}))[0].trade_price;
  const upBook = async sym => { const u = (await upGet("orderbook", {markets: sym}))[0].orderbook_units; return {bids: u.map(x => [x.bid_price, x.bid_size]), asks: u.map(x => [x.ask_price, x.ask_size])}; };
  const SIDE = {ASK: "SELL", BID: "BUY"};  // ask_bid는 시장가 주문 방향: ASK=매도, BID=매수
  const upTrades = async sym => (await upGet("trades/ticks", {market: sym, count: 200})).map(r =>
    ({ts: r.timestamp / 1000, price: r.trade_price, volume: r.trade_volume, side: SIDE[r.ask_bid] ?? null})).sort((a, b) => a.ts - b.ts);

  // ---- 바이낸스 선물 (futures.py)
  const bn = {
    exchangeInfo: async () => (await bnGet("/fapi/v1/exchangeInfo", null, 1)).symbols,
    tickers24h: () => bnGet("/fapi/v1/ticker/24hr", null, 40),
    premiumAll: () => bnGet("/fapi/v1/premiumIndex", null, 10),
    klines: (symbol, interval, limit = 120) => bnGet("/fapi/v1/klines", {symbol, interval, limit}, 2),
    depth: async (symbol, limit = 100) => { const d = await bnGet("/fapi/v1/depth", {symbol, limit}, 5); return {bids: d.bids.map(([p, q]) => [+p, +q]), asks: d.asks.map(([p, q]) => [+p, +q])}; },
    oiHist: (symbol, period = "1h", limit = 25) => bnGet("/futures/data/openInterestHist", {symbol, period, limit}, 1, bnData),
    topLs: (symbol, period = "1h", limit = 1) => bnGet("/futures/data/topLongShortAccountRatio", {symbol, period, limit}, 1, bnData),
    takerLs: (symbol, period = "1h", limit = 1) => bnGet("/futures/data/takerlongshortRatio", {symbol, period, limit}, 1, bnData),
    fundingInfo: async () => Object.fromEntries((await bnGet("/fapi/v1/fundingInfo", null, 1)).map(x => [x.symbol, +x.fundingIntervalHours])),
    async chartCandles(symbol, interval, limit = 500) {
      if (!CHART_INTERVALS.includes(interval)) throw new Error("시간봉은 1m·5m·15m·1h·4h·1d 중에서 고르세요");
      const rows = await bnGet("/fapi/v1/klines", {symbol, interval, limit}, 5);
      const t = interval === "1d" ? ms => new Date(ms).toISOString().slice(0, 10) : ms => Math.floor(ms / 1000);
      return rows.map(r => ({time: t(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4], value: +r[5]}));
    },
  };

  // ---- 심볼 정규화(app.py norm_symbol / resolve_symbol)
  function norm(raw) {
    const s = String(raw).trim().toUpperCase();
    if (!s || /^(KRW|USDT|BTC)-/.test(s)) return s;
    for (const [suf, q] of [["USDT", "USDT"], ["-KRW", "KRW"], ["KRW", "KRW"]]) if (s.endsWith(suf) && s.length > suf.length) return `${q}-${s.slice(0, -suf.length)}`;
    return `KRW-${s}`;
  }
  async function resolve(market, raw) {
    if (market !== "coin") throw new Error("주식은 한국투자증권 키가 필요한 서버 기능이라 이 모바일판에서는 지원하지 않습니다");
    let sym = norm(raw);
    try { await upPrice(sym); }
    catch (e) { if (!sym.startsWith("USDT-")) throw e; sym = "KRW-" + sym.slice(5); await upPrice(sym); }  // SUIUSDT처럼 USDT 마켓에 없으면 원화마켓으로
    return sym;
  }
  const emaSeeded = (values, n) => {  // indicators.py ema_seeded
    if (values.length < n) return [];
    const k = 2 / (n + 1); let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n; const out = [e];
    for (const v of values.slice(n)) { e = v * k + e * (1 - k); out.push(e); }
    return out;
  };

  // ---- 보유종목 (store.py + monitor.py)
  const H = "hc2_holdings", A = "hc2_alerts";
  const results = {};  // id -> {price, v, error, checked_at}
  async function refreshHoldings() {
    const hs = store.get(H, []);
    if (!hs.length) return hs;
    let px = {}, netErr = null;
    try { px = Object.fromEntries((await upGet("ticker", {markets: [...new Set(hs.map(h => h.symbol))].join(",")})).map(t => [t.market, t.trade_price])); }
    catch (e) { netErr = e.message; }
    const ts = nowSec(), alerts = store.get(A, {});
    let floors = hs;
    for (const h of hs) {
      if (netErr || px[h.symbol] == null) { results[h.id] = {...(results[h.id] || {}), error: netErr || "시세 없음", checked_at: results[h.id]?.checked_at}; continue; }
      try {
        const v = R.evaluate(h, await upDaily(h.symbol), px[h.symbol], tradingDay());
        results[h.id] = {price: px[h.symbol], v, error: null, checked_at: ts};
        if (v.stop > h.stop_floor) floors = floors.map(x => x.id === h.id ? {...x, stop_floor: v.stop} : x);  // 손절선은 올라가기만 한다
        const prev = alerts[h.id];
        if (v.status === "EXIT" || v.status === "TRIM") alerts[h.id] = prev && prev.status === v.status ? prev : {status: v.status, acked: false};
        else delete alerts[h.id];
      } catch (e) { results[h.id] = {price: px[h.symbol], v: null, error: e.message, checked_at: ts}; }
    }
    store.set(A, alerts);
    if (floors !== hs) store.set(H, floors);
    return floors;
  }
  async function holdingsList() {
    const hs = await refreshHoldings(), alerts = store.get(A, {});
    return hs.map(h => { const r = results[h.id] || {}; return {...h, price: r.price ?? null, error: r.error ?? null, checked_at: r.checked_at ?? null, verdict: r.v ?? null, alert: alerts[h.id] ?? null, history: []}; });
  }
  async function holdingAdd(h) {
    const avg = +h.avg_price, qty = +h.qty;
    if (!(avg > 0) || !(qty > 0)) throw new Error("평단과 수량은 0보다 커야 합니다");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.bought_at || "") || isNaN(Date.parse(h.bought_at))) throw new Error("매수일을 날짜로 입력하세요");
    let sym;
    try { sym = await resolve(h.market, h.symbol); } catch (e) { throw new Error(e.message.startsWith("주식은") ? e.message : "시세 조회 실패: 종목 코드를 확인하세요 (예: KRW-BTC)"); }
    if ((await upDaily(sym)).length < R.MIN_CANDLES + 1) throw new Error(`일봉이 ${R.MIN_CANDLES}개 이상인 종목만 감시할 수 있습니다 (신규 상장 제외)`);
    const id = nextId();
    store.set(H, [...store.get(H, []), {id, symbol: sym, market: "coin", avg_price: avg, qty, bought_at: h.bought_at, stage: 0, stop_floor: 0}]);
    return {id};
  }
  function holdingAck(id) {
    const alerts = store.get(A, {}), a = alerts[id], r = results[id];
    if (a) alerts[id] = {...a, acked: true};
    if (a && a.status === "TRIM" && r && r.v) store.set(H, store.get(H, []).map(h => h.id === id ? {...h, stage: Math.max(h.stage, r.v.stage)} : h));  // 익절 단계 래치: 같은 알림 반복 방지
    store.set(A, alerts);
    return {ok: true};
  }
  function holdingSold(id, qty) {
    const hs = store.get(H, []), h = hs.find(x => x.id === id);
    if (!h || !(qty > 0)) throw new Error("없는 보유종목이거나 수량이 잘못됐습니다");
    const left = Math.max(h.qty - qty, 0);
    store.set(H, left === 0 ? hs.filter(x => x.id !== id) : hs.map(x => x.id === id ? {...x, qty: +left.toPrecision(12)} : x));
    return {qty: left};
  }
  function holdingRemove(id) {
    store.set(H, store.get(H, []).filter(h => h.id !== id));
    const alerts = store.get(A, {}); delete alerts[id]; store.set(A, alerts);
    delete results[id];
    return {ok: true};
  }

  // ---- 그리기(store.py drawings)
  const D = "hc2_drawings", MAX_DRAWINGS = 50;
  const price = x => { if (typeof x !== "number" || !isFinite(x) || x <= 0 || x > 1e15) throw new Error("가격은 0보다 크고 너무 크지 않은 숫자여야 합니다"); return x; };
  const time = (t, iv) => {
    if (iv === "1d") { if (typeof t !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error("일봉의 시각은 YYYY-MM-DD 형식이어야 합니다"); return t; }
    if (!Number.isInteger(t) || !(t > 0 && t < 4e9)) throw new Error("분·시간봉의 시각은 UTC 초(양의 정수)여야 합니다");
    return t;
  };
  function cleanDrawing(kind, data, iv) {
    if (kind === "hline") return {price: price(data.price)};
    if (["trend", "fib", "rect"].includes(kind)) {
      const t1 = time(data.t1, iv), t2 = time(data.t2, iv);
      if (t1 === t2) throw new Error("두 점의 시각이 달라야 합니다");
      return {t1, p1: price(data.p1), t2, p2: price(data.p2)};
    }
    throw new Error("선 종류는 hline·trend·fib·rect 중 하나여야 합니다");
  }
  function drawingAdd(d) {
    const symbol = String(d.symbol || "").trim().toUpperCase();
    if (!symbol || symbol.length > 32 || !["coin", "stock", "futures"].includes(d.market)) throw new Error("종목 또는 시장이 올바르지 않습니다");
    if (!CHART_INTERVALS.includes(d.interval)) throw new Error("시간봉은 1m·5m·15m·1h·4h·1d 중에서 고르세요");
    const clean = cleanDrawing(d.kind, d.data && typeof d.data === "object" ? d.data : {}, d.interval), all = store.get(D, []);
    if (all.filter(x => x.symbol === symbol && x.market === d.market).length >= MAX_DRAWINGS) throw new Error(`종목당 선은 최대 ${MAX_DRAWINGS}개입니다`);
    const id = nextId();
    store.set(D, [...all, {id, symbol, market: d.market, kind: d.kind, interval: d.kind === "hline" ? "*" : d.interval, data: clean}]);  // 수평선은 모든 시간봉에서 보인다
    return {id};
  }
  function drawingPatch(id, data) {
    const all = store.get(D, []), d = all.find(x => x.id === id);
    if (!d) throw new Error("없는 선입니다");
    const clean = cleanDrawing(d.kind, data && typeof data === "object" ? data : {}, d.interval === "*" ? "1d" : d.interval);
    store.set(D, all.map(x => x.id === id ? {...x, data: clean} : x));
    return {ok: true};
  }
  const drawingRemove = id => { store.set(D, store.get(D, []).filter(x => x.id !== id)); return {ok: true}; };

  // ---- 차트
  async function chart(market, symbolRaw, interval) {
    const sym = decodeURIComponent(symbolRaw).trim().toUpperCase();
    if (!CHART_INTERVALS.includes(interval)) throw new Error("시간봉은 1m·5m·15m·1h·4h·1d 중에서 고르세요");
    if (market === "stock") throw new Error("주식은 이 모바일판에서 지원하지 않습니다");
    let candles;
    try {
      candles = market === "futures" ? await bn.chartCandles(sym, interval, 500)
        : interval === "1d" ? (await upDaily(sym, 400, true)).map(c => ({time: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, value: c.volume}))
        : await upChart(sym, interval, 400);
    } catch (e) { if (e instanceof RateLimited) throw e; throw new Error(e.message.includes("연결하지") ? e.message : "시세 조회 실패: 잠시 뒤 다시 시도하세요"); }
    if (!candles.length) throw new Error("차트 데이터가 없습니다(상장 직후이거나 종목 코드가 올바르지 않을 수 있습니다)");
    const closes = candles.map(c => c.close), ema = {};
    for (const n of [20, 50, 200]) if (closes.length >= n) ema[n] = emaSeeded(closes, n).map((value, i) => ({time: candles[n - 1 + i].time, value}));
    const levels = [];
    if (market !== "futures") for (const h of store.get(H, [])) if (h.symbol === sym && h.market === market) {
      levels.push({name: "평단", price: h.avg_price, kind: "avg"});
      const v = results[h.id]?.v;
      if (v) { levels.push({name: "손절", price: v.stop, kind: "stop"}); if (v.next_target) levels.push({name: "다음 익절", price: v.next_target, kind: "target"}); }
    }
    const drawings = store.get(D, []).filter(d => d.symbol === sym && d.market === market && (d.interval === interval || d.interval === "*")).map(({id, kind, data}) => ({id, kind, data}));
    return {candles, ema, levels, drawings, interval};
  }

  // ---- 관심종목 / 분석
  const W = "hc2_watch";
  async function watchAdd(w) {
    let sym;
    try { sym = await resolve(w.market, w.symbol); } catch (e) { throw new Error(e.message.startsWith("주식은") ? e.message : "시세 조회 실패: 종목 코드를 확인하세요"); }
    if ((await upDaily(sym)).length < IND.MIN_ANALYSIS + 1) throw new Error(`일봉이 ${IND.MIN_ANALYSIS}개 이상인 종목만 분석할 수 있습니다 (신규 상장 제외)`);
    const all = store.get(W, []);
    if (all.some(x => x.symbol === sym && x.market === "coin")) throw new Error("이미 등록된 관심종목입니다");
    const id = nextId(); store.set(W, [...all, {id, symbol: sym, market: "coin"}]);
    return {id};
  }
  async function analysis(market, symbolRaw) {
    const sym = decodeURIComponent(symbolRaw).trim().toUpperCase();
    if (market !== "coin") throw new Error("주식은 이 모바일판에서 지원하지 않습니다");
    let p, candles;
    try { [p, candles] = await Promise.all([upPrice(sym), upDaily(sym, 400)]); } catch { throw new Error("시세 조회 실패: 잠시 후 다시 시도하세요"); }
    let flow = null, flowError = null;
    try { const [b, t] = await Promise.all([upBook(sym), upTrades(sym)]); flow = IND.analyzeFlow(b, t, "coin"); }  // 수급이 실패해도 일봉 분석은 계속한다(단, 매수 검토는 내지 않는다)
    catch { flowError = "수급(호가·체결) 조회 실패: 일봉 기준으로만 분석했고, 수급 미확인이라 매수 검토는 내지 않습니다"; }
    return {...IND.analyze(candles, p, "coin", tradingDay(), flow, true), flow, flow_error: flowError};
  }

  // ---- 스캔 작업(진행률을 폴링하는 서버 작업 흉내)
  const jobs = {};
  const newState = () => ({status: "idle", progress: {done: 0, total: 0}, result: null, error: null});
  function startJob(key, fn) {
    const st = jobs[key] ||= newState();
    if (st.status === "running") throw new Error("이미 스캔 중입니다");
    Object.assign(st, {status: "running", progress: {done: 0, total: 0}, error: null});
    const progress = (done, total) => { st.progress = {done, total}; };
    fn(progress).then(r => Object.assign(st, {status: "done", result: r, error: null}), e => Object.assign(st, {status: "error", error: e.message || String(e)}));
    return {ok: true};
  }
  const jobState = key => ({...(jobs[key] ||= newState())});
  async function pool(items, workers, fn) {  // 순서를 유지하는 동시 실행
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({length: workers}, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
    return out;
  }
  const opt = async fn => { try { return await fn(); } catch (e) { if (e instanceof RateLimited) throw e; return null; } };  // 보조 재료: 실패하면 결측(속도 제한은 전파)

  async function upbitKrwBases() { return new Set((await upGet("market/all")).filter(m => m.market.startsWith("KRW-")).map(m => m.market.split("-")[1])); }

  async function scanRun(interval, topN, progress) {  // scanner.py Scanner._run
    if (!INTERVAL_MS[interval]) throw new Error("봉은 1h, 4h, 1d 중에서 고르세요");
    if (!(topN >= 1 && topN <= 200)) throw new Error("스캔 종목 수는 1~200개입니다");
    abort.on = false;
    try {
      let fx;
      try { fx = +(await upGet("ticker", {markets: "KRW-USDT"}))[0].trade_price; if (!(fx > 0)) throw new Error(); }
      catch { throw new Error("환율(업비트 KRW-USDT)을 구하지 못해 스캔하지 않았습니다"); }
      const upbit = await upbitKrwBases().catch(() => null);  // 모르면 모른다고 표시
      const tickers = await bn.tickers24h(), universe = SC.selectUniverse(await bn.exchangeInfo(), tickers, topN);
      const funding = Object.fromEntries((await bn.premiumAll()).filter(p => p.lastFundingRate !== "" && p.lastFundingRate != null).map(p => [p.symbol, +p.lastFundingRate]));
      const hours = (await opt(() => bn.fundingInfo())) || {};
      const chg = Object.fromEntries(tickers.filter(t => t.priceChangePercent !== "" && t.priceChangePercent != null).map(t => [t.symbol, +t.priceChangePercent]));
      let done = 0, aborted = null;
      progress(0, universe.length);
      const rows = await pool(universe, 6, async coin => {
        if (aborted) return null;
        let row;
        try { row = await scanRow(coin, interval, fx, funding, hours, chg[coin.symbol], upbit); }
        catch (e) {
          if (e instanceof RateLimited) { aborted = aborted || e; abort.on = true; return null; }
          row = {symbol: coin.symbol, base: coin.base, decision: "오류", error: e.message, F: null, T: null, P: null, blocks: [], plan: null, liquidity: null, reasons: {}, price: null, upbit: null};
        }
        progress(++done, universe.length);
        return row;
      });
      if (aborted) throw aborted;
      const errors = rows.filter(r => r.decision === "오류");
      if (rows.length && errors.length === rows.length) throw new Error("모든 종목을 읽지 못했습니다: " + errors[0].error);
      return {interval, top_n: topN, fx, collected_at: nowSec(), rows, error_count: errors.length, funding_interval_known: Object.keys(hours).length > 0};
    } finally { abort.on = false; }  // 같은 클라이언트를 쓰는 차트가 중단 신호에 막히지 않게
  }
  async function scanRow(coin, interval, fx, funding, hours, chg24, upbit) {
    const sym = coin.symbol, bars = SC.parseKlines(await bn.klines(sym, interval, 120));
    if (bars.length < 22) throw new Error("봉 데이터가 부족합니다");
    const cur = bars.at(-1), closed = bars.slice(0, -1);
    const frac = Math.max(0.005, Math.min(1, (Date.now() - cur.t) / INTERVAL_MS[interval]));
    const {bids, asks} = await bn.depth(sym, 100), liq = SC.liquidity(bids, asks, ORDER_USD);
    const b20 = IND.sum(bids.slice(0, 20).map(([p, q]) => p * q)), a20 = IND.sum(asks.slice(0, 20).map(([p, q]) => p * q));
    const ob = b20 + a20 > 0 ? (b20 - a20) / (b20 + a20) : null;
    const flow = SC.flowScore(bars, frac, fx, ob), F = flow ? flow[0] : null, fParts = flow ? flow[1] : {};
    const [T, tWhy] = SC.ichimokuTrend(closed);
    const oi = await opt(() => bn.oiHist(sym));
    // 계약 수(sumOpenInterest)로 계산: 평가액은 가격이 오르면 계약 수가 같아도 늘어 롱 쪽으로 기운다
    const oiChg = oi && oi.length >= 2 && +oi[0].sumOpenInterest > 0 ? (+oi.at(-1).sumOpenInterest / +oi[0].sumOpenInterest - 1) * 100 : null;
    const ls = await opt(async () => +(await bn.topLs(sym)).at(-1).longShortRatio), tk = await opt(async () => +(await bn.takerLs(sym)).at(-1).buySellRatio);
    const fund = funding[sym], fundPct = fund == null ? null : fund * 100 * (8 / (hours[sym] ?? 8));  // 8시간 기준 %
    const [P, pParts] = SC.positioning(fundPct, oiChg, chg24 ?? null, ls, tk);
    const decision = SC.decide(F, T, P), plan = decision === "롱" || decision === "숏" ? SC.tradePlan(decision, bars, cur.c) : null;
    const volKrw = coin.quote_volume * fx;
    return {symbol: sym, base: coin.base, price: cur.c, observed: nowSec(), change24h: chg24 ?? null, vol24_usd: coin.quote_volume, vol24_krw: volKrw,
      upbit: upbit == null ? null : upbit.has(SC.upbitBase(coin.base)), F, T, P, decision, frac, blocks: SC.blocks(decision, volKrw, plan ? plan.rr : null, frac),
      plan, liquidity: liq, error: null, reasons: {trend: tWhy, flow: fParts, positioning: pParts}};
  }

  // squeeze.py _liquid_markets: 24h 거래대금이 기준 이상인 종목과 시세표
  const MIN_KRW_24H = 1e9, MIN_USDT_24H = 2e7;
  async function liquidMarkets(venue) {
    if (venue === "binance") {
      const raw = await bn.tickers24h(), byS = Object.fromEntries(raw.map(t => [t.symbol, t]));
      const tick = {};
      for (const c of SC.selectUniverse(await bn.exchangeInfo(), raw, 1e6)) tick[c.symbol] = {trade_price: +byS[c.symbol].lastPrice, acc_trade_price_24h: c.quote_volume, signed_change_rate: +byS[c.symbol].priceChangePercent / 100};
      return {markets: Object.keys(tick).filter(m => tick[m].acc_trade_price_24h >= MIN_USDT_24H), tick};
    }
    const markets = (await upGet("market/all")).filter(m => m.market.startsWith("KRW-")).map(m => m.market);
    const tick = Object.fromEntries((await upGet("ticker", {markets: markets.join(",")})).map(t => [t.market, t]));
    return {markets: markets.filter(m => (tick[m]?.acc_trade_price_24h ?? 0) >= MIN_KRW_24H), tick};
  }
  const candlesOf = (venue, m, interval, n) => venue === "binance" ? bn.chartCandles(m, interval, n) : upChart(m, interval, n);

  async function squeezeRun(venue, interval, progress, minScore = 3) {
    abort.on = false;
    try {
      const {markets, tick} = await liquidMarkets(venue); let done = 0;
      progress(0, markets.length);
      const rows = await pool(markets, 4, async m => {
        let row;
        try {
          const s = SC.squeezeScore((await candlesOf(venue, m, interval, 520)).slice(0, -1));
          row = {market: m, price: tick[m].trade_price, vol24_krw: tick[m].acc_trade_price_24h, change24h: tick[m].signed_change_rate * 100, error: null};
          Object.assign(row, s || {score: null, error: "봉 부족"});
        } catch (e) { row = {market: m, score: null, error: e.message}; }
        progress(++done, markets.length);
        return row;
      });
      const ok = rows.filter(r => r.score != null).sort((a, b) => b.score - a.score || b.vol24_krw - a.vol24_krw);
      return {interval, scanned: ok.length, errors: rows.length - ok.length, collected_at: nowSec(), rows: ok.filter(r => r.score >= minScore)};
    } finally { abort.on = false; }
  }
  async function spikeRun(venue, interval, progress) {
    abort.on = false;
    try {
      const {markets, tick} = await liquidMarkets(venue); let done = 0;
      progress(0, markets.length);
      const out = await pool(markets, 4, async m => {
        let row = null, err = null;
        try {
          const sig = SC.volumeSpike((await candlesOf(venue, m, interval, 60)).slice(0, -1));  // 마지막은 진행 중인 봉
          if (sig) row = {market: m, price: tick[m].trade_price, change24h: tick[m].signed_change_rate * 100, ...sig};
        } catch (e) { err = e.message; }
        progress(++done, markets.length);
        return [row, err];
      });
      const rows = out.map(o => o[0]).filter(Boolean).sort((a, b) => a.age - b.age || b.vol_x - a.vol_x), same = {};
      for (const r of rows) same[r.age] = (same[r.age] || 0) + 1;  // 같은 봉에 폭발한 종목 수: 신호끼리 독립이 아니다
      for (const r of rows) r.same_bar = same[r.age];
      return {interval, scanned: markets.length, errors: out.filter(o => o[1]).length, collected_at: nowSec(), rows};
    } finally { abort.on = false; }
  }
  const SCAN_INTERVALS = ["15m", "1h", "4h", "1d"];
  const JOBS = {scan: (r, p) => scanRun(r.interval, r.top_n ?? 100, p), squeeze: (r, p) => squeezeRun("upbit", r.interval, p), spike: (r, p) => spikeRun("upbit", r.interval, p),
    "squeeze-bn": (r, p) => squeezeRun("binance", r.interval, p), "spike-bn": (r, p) => spikeRun("binance", r.interval, p)};

  // ---- 라우터: dashboard.html이 부르는 /api/* 형태를 그대로 받는다
  async function api(url, method = "GET", body) {
    const u = new URL(url, "http://local"), p = u.pathname.split("/").filter(Boolean).map(decodeURIComponent), m = method.toUpperCase();
    if (p[0] !== "api") throw new Error("알 수 없는 요청");
    const [, a, b, c] = p;
    if (a === "holdings") {
      if (m === "GET" && !b) return holdingsList();
      if (m === "POST" && !b) return holdingAdd(body);
      if (m === "POST" && c === "ack") return holdingAck(+b);
      if (m === "POST" && c === "sold") return holdingSold(+b, +body.qty);
      if (m === "DELETE" && b) return holdingRemove(+b);
    } else if (a === "chart" && m === "GET") return chart(b, c, u.searchParams.get("interval") || "1d");
    else if (a === "drawings") {
      if (m === "POST") return drawingAdd(body);
      if (m === "PATCH") return drawingPatch(+b, body.data);
      if (m === "DELETE") return drawingRemove(+b);
    } else if (a === "watch") {
      if (m === "GET") return store.get(W, []);
      if (m === "POST") return watchAdd(body);
      if (m === "DELETE") { store.set(W, store.get(W, []).filter(x => x.id !== +b)); return {ok: true}; }
    } else if (a === "analysis" && m === "GET") return analysis(b, c);
    else if (a === "status") return {telegram: false};
    else if (JOBS[a]) {
      if (m === "GET") return jobState(a);
      if (m === "POST") {
        if (a !== "scan" && !SCAN_INTERVALS.includes(body.interval)) throw new Error("봉은 " + SCAN_INTERVALS.join(", ") + " 중에서 고르세요");
        return startJob(a, pr => JOBS[a](body, pr));
      }
    }
    throw new Error("이 모바일판에서 지원하지 않는 기능입니다");
  }

  return {api, norm, tradingDay, scanRun, squeezeRun, spikeRun, store, _bn: bn, _up: {upGet, upDaily, upChart}};
});
