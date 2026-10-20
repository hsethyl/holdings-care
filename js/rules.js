// trading-assistant/rules.py 포팅(코인 전용). 브라우저에선 전역 HC_RULES, Node에선 require 겸용.
// 일봉 candles: [{ts,open,high,low,close,volume}] 오래된 것부터.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HC_RULES = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const CAP = {coin: 0.08}, ATR_N = 14, EMA_N = 20, MIN_CANDLES = 22, ATR_FLOOR = 0.005;
  const TRIM1_R = 1.5, TRIM2_R = 3.0, TIME_STOP_DAYS = 10, EPS = 1e-9;

  // 파이썬 '%.{p}g' 서식(과학표기 경계와 뒤쪽 0 제거까지 같게)
  function pyG(x, p) {
    if (x === 0) return "0";
    const [m, e] = x.toExponential(p - 1).split("e"), exp = parseInt(e, 10);
    if (exp < -4 || exp >= p) {
      const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
      return `${mant}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
    }
    const t = x.toFixed(Math.max(p - 1 - exp, 0));
    return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
  }
  const roundHalfEven = x => { const f = Math.floor(x), d = x - f; return d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1); };  // 파이썬 '{:,.0f}'와 같은 반올림
  const fmt = x => x == null ? "-" : (Math.abs(x) >= 100 ? roundHalfEven(x).toLocaleString("en-US") : pyG(x, 4));

  function atr(c, n = ATR_N) {
    if (c.length < n + 1) throw new Error(`ATR에 일봉 ${n + 1}개 필요`);
    const prev = c.slice(-n - 1, -1), cur = c.slice(-n);
    return cur.reduce((s, x, i) => s + Math.max(x.high - x.low, Math.abs(x.high - prev[i].close), Math.abs(x.low - prev[i].close)), 0) / n;
  }
  function ema(v, n = EMA_N) { const k = 2 / (n + 1); return v.slice(1).reduce((e, x) => x * k + e * (1 - k), v[0]); }

  // pos: {avg_price, bought_at, stage, stop_floor, market}; today: 'YYYY-MM-DD'(거래일: 업비트 일봉은 09:00 KST에 바뀐다)
  function evaluate(pos, daily, price, today) {
    const closed = daily.filter(c => c.ts < today);
    if (closed.length < MIN_CANDLES) throw new Error(`일봉 ${closed.length}개: ${MIN_CANDLES}개 이상 필요`);
    const avg = pos.avg_price, a = Math.max(atr(closed), avg * ATR_FLOOR);
    const initStop = Math.max(avg - 2 * a, avg * (1 - CAP[pos.market || "coin"]));
    const r = avg - initStop;
    const since = closed.filter(c => c.ts >= pos.bought_at);
    const peakClose = since.length ? Math.max(...since.map(c => c.close)) : avg;
    const peakHigh = Math.max(...since.map(c => c.high), price);
    const stageNow = price >= avg + TRIM2_R * r ? 2 : price >= avg + TRIM1_R * r ? 1 : 0;
    const stage = Math.max(pos.stage, stageNow);
    let stop = Math.max(initStop, peakClose - 3 * a);
    if (stage >= 1) stop = Math.max(stop, avg);
    stop = Math.max(stop, pos.stop_floor);
    const target = stage >= 2 ? null : avg + (stage ? TRIM2_R : TRIM1_R) * r;
    const pnl = (price / avg - 1) * 100;
    const v = (status, reason) => ({status, stop, next_target: target, pnl_pct: pnl, stage, reason});
    const closes = closed.map(c => c.close), eNow = ema(closes), ePrev = ema(closes.slice(0, -1));
    const held = Math.round((Date.parse(today) - Date.parse(pos.bought_at)) / 864e5);
    if (price <= stop) return v("EXIT", `가격 ${fmt(price)} ≤ 손절선 ${fmt(stop)}: 규칙대로 손절하세요`);
    if (closes.at(-1) < eNow * (1 - EPS) && eNow < ePrev * (1 - EPS)) return v("EXIT", "일봉 종가가 EMA20 아래이고 EMA20 하락 중: 추세 이탈, 전량 매도 권고");
    if (held >= TIME_STOP_DAYS && peakHigh < avg + r) return v("EXIT", `${held}일 경과, 최고가가 +1R(${fmt(avg + r)}) 미달: 시간 손절, 정리 권고`);
    if (stageNow > pos.stage) return v("TRIM", `${stageNow === 1 ? "1차(+1.5R)" : "2차(+3R)"} 익절 구간: 보유분의 1/3 매도 권고, 손절선 ${fmt(stop)}으로 상향`);
    if (price - stop <= 0.5 * a) return v("WARN", `손절선 ${fmt(stop)}까지 ${fmt(price - stop)} (0.5×ATR 이내)`);
    return v("HOLD", `손절선 ${fmt(stop)}, 다음 익절 ${target ? fmt(target) : "추적 손절"}`);
  }

  return {evaluate, fmt, pyG, atr, ema, CAP, ATR_FLOOR, MIN_CANDLES};
});
