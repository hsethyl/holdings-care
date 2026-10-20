// indicators.py + flow.py + analysis.py 포팅. 브라우저 전역 HC_IND, Node에선 require 겸용.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./rules.js"));
  else root.HC_IND = factory(root.HC_RULES);
})(typeof self !== "undefined" ? self : this, function (R) {
  const {atr, ema, fmt, pyG, CAP, ATR_FLOOR} = R;
  const sum = a => a.reduce((s, x) => s + x, 0);
  const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pyRound = x => { const f = Math.floor(x), d = x - f; return d < 0.5 ? f : d > 0.5 ? f + 1 : (f % 2 === 0 ? f : f + 1); };  // 파이썬 round(): 반올림이 아닌 짝수 쪽
  const s2 = x => (x >= 0 ? "+" : "-") + Math.abs(x).toFixed(2);  // 파이썬 '{x:+.2f}'
  const sgn = (x, p) => (x >= 0 ? "+" : "-") + pyG(Math.abs(x), p);

  // ---------------- indicators.py ----------------
  function emaSeries(values, n) {
    const k = 2 / (n + 1); let e = values[0]; const out = [e];
    for (const v of values.slice(1)) { e = v * k + e * (1 - k); out.push(e); }
    return out;
  }
  function rsi(closes, n = 14) {
    if (closes.length < n + 1) throw new Error(`RSI에 종가 ${n + 1}개 필요`);
    const d = closes.slice(1).map((b, i) => b - closes[i]);
    let gain = sum(d.slice(0, n).map(x => Math.max(x, 0))) / n, loss = sum(d.slice(0, n).map(x => Math.max(-x, 0))) / n;
    for (const x of d.slice(n)) { gain = (gain * (n - 1) + Math.max(x, 0)) / n; loss = (loss * (n - 1) + Math.max(-x, 0)) / n; }
    return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  function macdHist(closes, fast = 12, slow = 26, signal = 9) {
    const f = emaSeries(closes, fast), s = emaSeries(closes, slow), macd = f.map((x, i) => x - s[i]);
    const sig = emaSeries(macd, signal), hist = macd.map((m, i) => m - sig[i]);
    return [hist.at(-1), hist.at(-2)];
  }
  function rsiSeries(closes, n = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < n + 1) return out;
    const d = closes.slice(1).map((b, i) => b - closes[i]);
    let gain = sum(d.slice(0, n).map(x => Math.max(x, 0))) / n, loss = sum(d.slice(0, n).map(x => Math.max(-x, 0))) / n;
    out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let k = n; k < d.length; k++) {
      gain = (gain * (n - 1) + Math.max(d[k], 0)) / n; loss = (loss * (n - 1) + Math.max(-d[k], 0)) / n;
      out[k + 1] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  // ---------------- flow.py ----------------
  const DEPTH = 5, WALL_LEVELS = 10, WALL_MULT = 5.0, NEAR = 3, WHALE_MIN = {coin: 1e8, stock: 5e7};
  const FLOW_LABEL = {BUY_SIDE: "매수 우위", SELL_SIDE: "매도 우위", NEUTRAL: "중립"};

  function walls(levels, side) {
    const vals = levels.map(([p, s]) => p * s);
    let base = median(vals);
    if (base <= 0) base = sum(vals) / vals.length;
    if (base <= 0) return [];
    return vals.flatMap((v, i) => v >= WALL_MULT * base ? [{side, price: levels[i][0], level: i + 1, ratio: v / base}] : []);
  }
  const span = sec => sec < 60 ? `${sec.toFixed(0)}초` : `${(sec / 60).toFixed(0)}분`;

  // book: {bids:[[가격,수량]], asks}, trades: [{ts(초), price, volume, side}]
  function analyzeFlow(book, trades, market) {
    const bids = book.bids.slice(0, WALL_LEVELS), asks = book.asks.slice(0, WALL_LEVELS);
    if (!bids.length || !asks.length) throw new Error("호가가 비어 있습니다");
    const b5 = sum(bids.slice(0, DEPTH).map(([p, s]) => p * s)), a5 = sum(asks.slice(0, DEPTH).map(([p, s]) => p * s));
    const imbalance = b5 + a5 > 0 ? (b5 - a5) / (b5 + a5) : 0;
    const w = [...walls(bids, "BUY"), ...walls(asks, "SELL")];
    const sellNear = w.some(x => x.side === "SELL" && x.level <= NEAR), buyNear = w.some(x => x.side === "BUY" && x.level <= NEAR);
    const buyV = sum(trades.filter(t => t.side === "BUY").map(t => t.price * t.volume));
    const sellV = sum(trades.filter(t => t.side === "SELL").map(t => t.price * t.volume));
    const ratio = buyV + sellV > 0 ? buyV / (buyV + sellV) : null;
    const big = trades.filter(t => t.price * t.volume >= WHALE_MIN[market]);
    const whales = [...big].sort((a, b) => b.ts - a.ts).slice(0, 5).map(t => ({ts: t.ts, side: t.side, value: t.price * t.volume}));
    const n = trades.length, tss = trades.map(t => t.ts), window_sec = n ? Math.max(...tss) - Math.min(...tss) : 0;
    const whaleNet = sum(big.filter(t => t.side).map(t => t.price * t.volume * (t.side === "BUY" ? 1 : -1)));
    let score = 0; const notes = [];
    if (imbalance > 0.2) { score++; notes.push(`상위 5호가 매수 쪽이 두텁습니다 (${s2(imbalance)})`); }
    else if (imbalance < -0.2) { score--; notes.push(`상위 5호가 매도 쪽이 두텁습니다 (${s2(imbalance)})`); }
    if (ratio != null && ratio > 0.55) { score++; notes.push(`시장가 매수 체결이 우세합니다 (${(ratio * 100).toFixed(0)}%, 최근 ${n}건·약 ${span(window_sec)})`); }
    else if (ratio != null && ratio < 0.45) { score--; notes.push(`시장가 매도 체결이 우세합니다 (매수 ${(ratio * 100).toFixed(0)}%, 최근 ${n}건·약 ${span(window_sec)})`); }
    if (whaleNet > 0) { score++; notes.push("고래 순매수 체결이 있습니다"); }
    else if (whaleNet < 0) { score--; notes.push("고래 순매도 체결이 있습니다"); }
    if (buyNear) { score++; notes.push("상위 3호가 안에 매수벽이 있습니다"); }
    if (sellNear) { score--; notes.push("상위 3호가 안에 매도벽이 있습니다"); }
    const tradeConfirms = (ratio != null && ratio > 0.55) || whaleNet > 0;
    const verdict = score >= 2 && tradeConfirms ? "BUY_SIDE" : score <= -2 ? "SELL_SIDE" : "NEUTRAL";
    const summary = `${FLOW_LABEL[verdict]}: ` + (notes.length ? notes.join("; ") : "특이사항 없음");
    return {verdict, imbalance, walls: w, taker_buy_ratio: ratio, whales, notes, sell_wall_near: sellNear, summary, n_trades: n, window_sec};
  }

  // ---------------- analysis.py ----------------
  const MIN_ANALYSIS = 60, BUY_SCORE = 70, WAIT_SCORE = 45, SLOPE_BARS = 5, MUST_PASS = ["추세", "위치"];

  function decide(score, vetoes, checks, flow, requireFlow) {
    if (vetoes.length) return "AVOID";
    if (score >= BUY_SCORE) {
      const sellPressure = flow != null && (flow.verdict === "SELL_SIDE" || flow.sell_wall_near);
      const unconfirmed = requireFlow && flow == null;
      return checks.filter(c => MUST_PASS.includes(c.name)).every(c => c.ok) && !sellPressure && !unconfirmed ? "BUY" : "WAIT";
    }
    return score >= WAIT_SCORE ? "WAIT" : "AVOID";
  }
  function volumeCheck(closed) {
    const vols = closed.slice(-23).map(c => c.volume);
    if (vols.length < 23 || Math.min(...vols) <= 0) return {name: "거래량 동반", ok: null, points: 10, detail: "거래량 데이터가 부족해 생략"};
    const ratio = (sum(vols.slice(-3)) / 3) / (sum(vols.slice(0, -3)) / 20);
    return {name: "거래량 동반", ok: ratio >= 1.2, points: 10, detail: `최근 3봉 평균 거래량이 직전 20봉 평균의 ${ratio.toFixed(1)}배`};
  }

  function analyze(candles, price, market, today, flow, requireFlow) {
    if (price <= 0) throw new Error("현재가가 0 이하입니다");
    const closed = candles.filter(c => c.ts < today);
    if (closed.length < MIN_ANALYSIS) throw new Error(`일봉 ${closed.length}개: ${MIN_ANALYSIS}개 이상 필요`);
    const closes = closed.map(c => c.close), close = closes.at(-1);
    const a = Math.max(atr(closed), price * ATR_FLOOR);
    const e20 = ema(closes, 20), e50 = ema(closes, 50), e50prev = ema(closes.slice(0, -SLOPE_BARS), 50);
    const r = rsi(closes), [hist, histPrev] = macdHist(closes);
    const cap = CAP[market], risk = 2 * a / price;
    const has200 = closes.length >= 200;
    const checks = [
      {name: "추세", ok: close > e50 && e20 > e50 && e50 > e50prev, points: 30,
        detail: `종가 ${fmt(close)}, EMA20 ${fmt(e20)}, EMA50 ${fmt(e50)} (${SLOPE_BARS}봉 전보다 ${e50 > e50prev ? "상승" : "하락"})`},
      {name: "장기 방향", ok: has200 ? close > ema(closes, 200) : null, points: 10, detail: has200 ? `EMA200 ${fmt(ema(closes, 200))}` : "일봉 200개 미만이라 생략"},
      {name: "과열", ok: r >= 40 && r <= 65, points: 20, detail: `RSI ${r.toFixed(0)} (매수 구간 40~65)`},
      {name: "모멘텀", ok: hist > 0 && hist > histPrev, points: 15, detail: `MACD 히스토그램 ${sgn(hist, 3)} (직전 ${sgn(histPrev, 3)})`},
      {name: "위치", ok: price <= e20 + a, points: 15, detail: `현재가 ${fmt(price)} / EMA20+ATR ${fmt(e20 + a)}`},
      {name: "손절폭", ok: risk <= cap, points: 10, detail: `2×ATR 손절폭 ${(risk * 100).toFixed(1)}% (상한 ${(cap * 100).toFixed(0)}%)`},
      {name: "수급", ok: flow ? ({BUY_SIDE: true, SELL_SIDE: false}[flow.verdict] ?? null) : null, points: 15, detail: flow ? flow.summary : "호가·체결을 받지 못해 생략"},
      volumeCheck(closed),
    ];
    const vetoes = [];
    if (close < e50 && e50 < e50prev) vetoes.push("하락 추세: 종가가 하락 중인 EMA50 아래");
    if (r > 75) vetoes.push(`과열: RSI ${r.toFixed(0)} > 75`);
    if (price > e20 + 3 * a) vetoes.push("추격 금지: 현재가가 EMA20보다 3×ATR 넘게 위");
    if (risk > cap) vetoes.push(`손절폭 초과: 2×ATR ${(risk * 100).toFixed(1)}% > 상한 ${(cap * 100).toFixed(0)}%`);
    const live = checks.filter(c => c.ok !== null);
    const score = pyRound(100 * sum(live.filter(c => c.ok).map(c => c.points)) / sum(live.map(c => c.points)));
    const verdict = decide(score, vetoes, checks, flow, requireFlow);
    let plan = null;
    if (verdict === "BUY") {
      const stop = Math.max(price - 2 * a, price * (1 - cap)), rr = price - stop;
      plan = {entry: price, stop, target1: price + 1.5 * rr, target2: price + 3 * rr};
    }
    const failed = live.filter(c => !c.ok).map(c => c.name);
    if (flow && (flow.verdict === "SELL_SIDE" || flow.sell_wall_near) && !failed.includes("수급")) failed.push("수급 매도 압력");
    if (requireFlow && !flow) failed.push("수급 미확인");
    const missed = failed.join(", ") || "없음";
    const summary = {BUY: `매수 검토 (${score}점)`, WAIT: `관망 (${score}점): 미충족 ${missed}`,
      AVOID: `매수 금지 (${score}점): ` + (vetoes.length ? vetoes[0] : `점수 부족, 미충족 ${missed}`)}[verdict];
    return {verdict, score, checks, vetoes, plan, summary};
  }

  return {emaSeries, rsi, macdHist, rsiSeries, analyzeFlow, analyze, median, sum, pyRound, MIN_ANALYSIS};
});
