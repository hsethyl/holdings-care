// fixtures.json(파이썬 원본 결과)과 js/*.js 결과를 대조한다. 실행: node tools/compare.js
const fs = require("fs"), path = require("path");
const R = require("../js/rules.js"), IND = require("../js/ind.js"), S = require("../js/scan.js");
const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));
let bad = 0, total = 0;
const fails = {};

function same(a, b, p = "") {  // 숫자는 상대오차 1e-9, 나머지는 엄격 동일. 불일치 경로를 돌려준다
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${p}: ${a} != ${b}`;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null) ? null : `${p}: ${a} != ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${p}: len ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) { const r = same(a[i], b[i], `${p}[${i}]`); if (r) return r; }
    return null;
  }
  if (typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const r = same(a[k], b[k], `${p}.${k}`); if (r) return r; }
    return null;
  }
  return a === b ? null : `${p}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}
function check(group, got, exp) {
  total++;
  const r = same(got, exp);
  if (r) { bad++; (fails[group] ||= []).push(r); }
}
const upCandles = rows => rows.slice().reverse().map(r => ({ts: r.candle_date_time_kst.slice(0, 10), open: r.opening_price, high: r.high_price,
  low: r.low_price, close: r.trade_price, volume: r.candle_acc_trade_volume ?? 0}));
const upBook = ob => ({bids: ob[0].orderbook_units.map(u => [u.bid_price, u.bid_size]), asks: ob[0].orderbook_units.map(u => [u.ask_price, u.ask_size])});
const SIDE = {ASK: "SELL", BID: "BUY"};
const upTrades = tk => tk.map(r => ({ts: r.timestamp / 1000, price: r.trade_price, volume: r.trade_volume, side: SIDE[r.ask_bid] ?? null})).sort((a, b) => a.ts - b.ts);
const TODAY = "2026-10-20";

for (const c of fx.holdings) check("holdings", R.evaluate(c.pos, upCandles(c.rows), c.price, TODAY), c.expect);

for (const c of fx.analysis) {
  const flow = c.flow_expect ? IND.analyzeFlow(upBook(c.ob), upTrades(c.tk), "coin") : null;
  if (c.flow_expect) check("flow", flow, c.flow_expect);
  let got;
  try { got = IND.analyze(upCandles(c.rows), c.price, "coin", TODAY, c.use_flow ? flow : null, c.req); } catch (e) { got = {error: e.message}; }
  check("analysis", got, c.expect);
}

for (const c of fx.scan) {
  const bars = S.parseKlines(c.rows), closed = bars.slice(0, -1), cur = bars.at(-1);
  const f = S.flowScore(bars, c.frac, c.fx, c.ob), [T, why] = S.ichimokuTrend(closed);
  const book = [c.depth.bids, c.depth.asks].map(l => l.map(([p, q]) => [+p, +q]));
  const plans = {"롱": S.tradePlan("롱", bars, cur.c), "숏": S.tradePlan("숏", bars, cur.c)};
  check("scan", {flow: f ? {score: f[0], parts: f[1]} : null, T, why, liq: S.liquidity(book[0], book[1], 10000), plans},
    {flow: c.expect.flow ? {score: c.expect.flow[0], parts: c.expect.flow[1]} : null, T: c.expect.T, why: c.expect.why, liq: c.expect.liq, plans: c.expect.plans});
}
{ const u = fx.universe; check("universe", S.selectUniverse(u.info, u.tick, u.n), u.expect); }
for (const c of fx.positioning) check("positioning", S.positioning(...c.a), c.expect);
for (const c of fx.decide) check("decide", S.decide(...c.a), c.expect);
for (const c of fx.squeeze) {
  if (c.expect.sq !== null) check("squeeze", S.squeezeScore(c.bars), c.expect.sq);
  check("spike", S.volumeSpike(c.bars.length > 59 ? c.bars.slice(-59) : c.bars), c.expect.sp);
}

for (const [g, l] of Object.entries(fails)) console.log("FAIL", g, l.length, l.slice(0, 3));
console.log(`${total - bad}/${total} 일치`);
process.exit(bad ? 1 : 0);
