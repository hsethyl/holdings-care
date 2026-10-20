// scan.py(롱/숏 스캔 순수 계산) + squeeze.py(응축·거래량 폭발 순수 계산) 포팅. 브라우저 전역 HC_SCAN, Node에선 require 겸용.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./ind.js"));
  else root.HC_SCAN = factory(root.HC_IND);
})(typeof self !== "undefined" ? self : this, function (IND) {
  const {median, sum, rsiSeries} = IND;
  const STABLE_BASES = new Set(["USDC", "USDT", "BUSD", "FDUSD", "TUSD", "DAI", "USDP", "USDE", "USD1", "RLUSD", "EURI", "AEUR"]);
  const MIN_TREND_BARS = 78;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const range = (a, b) => Array.from({length: Math.max(b - a, 0)}, (_, i) => a + i);

  // 바이낸스 klines 행 → {t,o,h,l,c,vol,qv,tbq}
  const parseKlines = rows => rows.map(r => ({t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], vol: +r[5], qv: +r[7], tbq: +r[10]}));

  function mid(bars, i, n) { const seg = bars.slice(i - n + 1, i + 1); return (Math.max(...seg.map(b => b.h)) + Math.min(...seg.map(b => b.l))) / 2; }
  function atr14(bars, n = 14) {
    const trs = bars.slice(1).map((b, k) => Math.max(b.h - b.l, Math.abs(b.h - bars[k].c), Math.abs(b.l - bars[k].c))).slice(-n);
    return sum(trs) / trs.length;
  }

  // ---------------- T (추세) ----------------
  function recentCross(diffs, window) {
    if (diffs.length < 2) return 0;
    const now = diffs.at(-1), prior = diffs.slice(-1 - window, -1);
    if (now > 0 && prior.some(d => d <= 0)) return 1;
    if (now < 0 && prior.some(d => d >= 0)) return -1;
    return 0;
  }
  function divergence(bars, rsis, look = 3, span = 40, maxAge = 6) {
    const i = bars.length - 1, ks = range(Math.max(look, i - span), i - look + 1);
    const pivots = (key, better) => ks.filter(k => rsis[k] != null &&
      range(k - look, k + look + 1).filter(j => j !== k).every(j => better(key(bars[k]), key(bars[j]))));
    const lows = pivots(b => b.l, (a, b) => a < b);
    if (lows.length >= 2 && i - lows.at(-1) <= maxAge) {
      const [k1, k2] = lows.slice(-2);
      if (bars[k2].l < bars[k1].l && rsis[k2] > rsis[k1]) return 1;
    }
    const highs = pivots(b => b.h, (a, b) => a > b);
    if (highs.length >= 2 && i - highs.at(-1) <= maxAge) {
      const [k1, k2] = highs.slice(-2);
      if (bars[k2].h > bars[k1].h && rsis[k2] < rsis[k1]) return -1;
    }
    return 0;
  }
  // [T|null, 사유[]]
  function ichimokuTrend(bars) {
    if (bars.length < MIN_TREND_BARS) return [null, ["추세 계산 불가: 마감 봉 78개 미만"]];
    const i = bars.length - 1, c = bars[i].c, tenkan = mid(bars, i, 9), kijun = mid(bars, i, 26), j = i - 26;
    const spanA = (mid(bars, j, 9) + mid(bars, j, 26)) / 2, spanB = mid(bars, j, 52);
    const top = Math.max(spanA, spanB), bot = Math.min(spanA, spanB);
    let s = 50; const why = [];
    const add = (v, text) => { s += v; why.push(`${text} ${v >= 0 ? "+" : "-"}${Math.abs(v)}`); };
    if (c > top) add(18, "구름 위"); else if (c < bot) add(-18, "구름 아래");
    if (spanA > spanB) add(7, "구름 상승색"); else if (spanA < spanB) add(-7, "구름 하락색");
    if (c > kijun) add(8, "기준선 위"); else if (c < kijun) add(-8, "기준선 아래");
    if (tenkan > kijun) add(7, "전환선>기준선"); else if (tenkan < kijun) add(-7, "전환선<기준선");
    const cross = recentCross(range(i - 5, i + 1).map(k => mid(bars, k, 9) - mid(bars, k, 26)), 5);
    if (cross) add(8 * cross, cross > 0 ? "골든크로스" : "데드크로스");
    if (c > bars[i - 26].h) add(8, "후행스팬 자유"); else if (c < bars[i - 26].l) add(-8, "후행스팬 막힘");
    const div = divergence(bars, rsiSeries(bars.map(b => b.c)));
    if (div > 0) add(12, "RSI 상승 다이버전스"); else if (div < 0) add(-14, "RSI 하락 다이버전스");
    const v10 = sum(bars.slice(-10).map(b => b.qv)) / 10, v40 = sum(bars.slice(-40).map(b => b.qv)) / 40;
    if (v40 > 0 && v10 / v40 > 1.25) add(6, "거래량 증가 추세"); else if (v40 > 0 && v10 / v40 < 0.7) add(-4, "거래량 감소 추세");
    return [clamp(s, 0, 100), why];
  }

  // ---------------- F (흐름) ----------------
  const mfm = b => b.h > b.l ? ((b.c - b.l) - (b.h - b.c)) / (b.h - b.l) : 0;
  function penalty(chg10, highDd, pos52) {
    let p = 0;
    if (chg10 > 0.25) p += Math.min(26, (chg10 - 0.25) * 55);
    if (highDd < -0.08) p += Math.min(20, (-highDd - 0.08) * 150);
    if (pos52 > 0.93) p += 7;
    return p;
  }
  // [F, 재료] 또는 null(표본 부족)
  function flowScore(bars, frac, krwPerUsdt, obImb) {
    if (bars.length < 21) return null;
    const cur = bars.at(-1), base = median(bars.slice(-21, -1).map(b => b.qv));
    if (base <= 0) return null;
    frac = clamp(frac, 0.005, 1);
    const conf = clamp(frac / 0.25, 0.45, 1);
    const damp = clamp(Math.log10(Math.max(cur.qv * krwPerUsdt, 1e5) / 1e6) / Math.log10(50), 0.15, 1) * conf;
    const volPace = (cur.qv / Math.max(frac, 0.15)) / base;
    const s1 = clamp(Math.log10(Math.max(volPace, 0.05)) / Math.log10(8), 0, 1) * 100 * damp;
    const taker = cur.qv > 0 ? cur.tbq / cur.qv : null;
    const s2 = taker == null ? null : 50 + 50 * clamp((taker - 0.5) * 4, -1, 1);
    const last = bars.slice(-10), den = sum(last.map(b => b.qv));
    const ad = den > 0 ? clamp(sum(last.map(b => mfm(b) * b.qv)) / den, -1, 1) : 0;
    const s5 = 50 + 50 * clamp(ad * 2.2, -1, 1);
    const parts = [[0.28, s1], [0.14, s5], ...(s2 != null ? [[0.26, s2]] : [])];
    if (obImb != null) parts.push([0.10, 50 + 50 * clamp(obImb * 2, -1, 1)]);
    const weighted = sum(parts.map(([w, s]) => w * s)) / sum(parts.map(([w]) => w));
    const chg10 = cur.c / bars.at(-11).c - 1, highDd = cur.c / Math.max(...bars.slice(-6).map(b => b.h)) - 1;
    const hh = Math.max(...bars.slice(-52).map(b => b.h)), ll = Math.min(...bars.slice(-52).map(b => b.l));
    const pos52 = hh > ll ? (cur.c - ll) / (hh - ll) : 0.5;
    return [clamp(weighted - penalty(chg10, highDd, pos52), 0, 100),
      {vol_pace: volPace, taker_ratio: taker, ad_slope: ad, chg10, ob_imb: obImb}];
  }

  // ---------------- P (포지셔닝) ----------------
  // [P|null, 재료 {이름: 점수}]
  function positioning(fundingPct, oiChgPct, priceChgPct, lsRatio, takerRatio) {
    const v = {};
    if (fundingPct != null) v["펀딩비"] = fundingPct > 0.05 ? -2 : fundingPct > 0.02 ? -1 : fundingPct < -0.05 ? 2 : fundingPct < -0.02 ? 1 : 0;
    if (oiChgPct != null && priceChgPct != null) v["미결제약정"] = oiChgPct < 5 ? 0 : (priceChgPct > 0 ? 1 : priceChgPct < 0 ? -1 : 0);
    if (lsRatio != null) v["탑트레이더 롱숏비"] = lsRatio > 2.0 ? -1 : lsRatio < 0.6 ? 1 : 0;
    if (takerRatio != null) v["테이커 롱숏비"] = takerRatio > 1.2 ? 1 : takerRatio < 0.8 ? -1 : 0;
    const vals = Object.values(v);
    if (vals.length < 2) return [null, v];
    return [clamp(sum(vals) / vals.length * 2, -2, 2), v];
  }

  function decide(F, T, P) {
    if (F == null || T == null || P == null) return "판정 없음";
    if (F >= 60 && T >= 60) return P >= 0 ? "롱" : "롱 관망";
    if (F <= 40 && T <= 40) return P <= 0 ? "숏" : "숏 관망";
    return "없음";
  }
  function blocks(decision, vol24Krw, rr, frac) {
    if (decision !== "롱" && decision !== "숏") return [];
    const out = [];
    if (vol24Krw < 4e10) out.push("24h 거래대금 400억 원 미만");
    if (rr == null || rr < 2) out.push("손익비 2 미만");
    if (frac < 0.15) out.push("봉 초반(경과율 15% 미만)");
    return out;
  }

  // ---------------- 유동성 ----------------
  function slippageBps(levels, midPrice, orderUsd, buy) {
    let remaining = orderUsd, qty = 0;
    for (const [p, q] of levels) {
      const take = Math.min(remaining, p * q);
      qty += take / p; remaining -= take;
      if (remaining <= 1e-9) break;
    }
    if (remaining > 1e-6) return null;
    const avg = orderUsd / qty;
    return ((buy ? avg - midPrice : midPrice - avg) / midPrice) * 1e4;
  }
  function liquidity(bids, asks, orderUsd = 10000) {
    if (!bids.length || !asks.length) throw new Error("호가가 비어 있습니다");
    const b1 = bids[0][0], a1 = asks[0][0], m = (a1 + b1) / 2, spreadBps = (a1 - b1) / m * 1e4;
    const half = Math.min(asks.at(-1)[0] / m - 1, 1 - bids.at(-1)[0] / m), r = Math.max(0, Math.min(half, 0.01));
    const askDepth = sum(asks.filter(([p]) => p <= m * (1 + r)).map(([p, q]) => p * q));
    const bidDepth = sum(bids.filter(([p]) => p >= m * (1 - r)).map(([p, q]) => p * q));
    const buy = slippageBps(asks, m, orderUsd, true), sell = slippageBps(bids, m, orderUsd, false);
    const slip = buy == null || sell == null ? null : Math.max(buy, sell);
    const grade = slip == null || spreadBps > 15 || slip > 50 ? "나쁨" : spreadBps <= 3 && slip <= 10 ? "좋음" : "보통";
    return {spread_bps: spreadBps, depth_usd: Math.min(askDepth, bidDepth), depth_range_pct: r * 100, depth_truncated: half < 0.01,
      slippage_buy_bps: buy, slippage_sell_bps: sell, slippage_bps: slip, grade};
  }

  // ---------------- 매매계획 ----------------
  function tradePlan(side, bars, price) {
    const atr = atr14(bars), low10 = Math.min(...bars.slice(-10).map(b => b.l)), high10 = Math.max(...bars.slice(-10).map(b => b.h));
    const high40 = Math.max(...bars.slice(-40).map(b => b.h)), low40 = Math.min(...bars.slice(-40).map(b => b.l)), swing = high40 - low40;
    const lo = price * 0.022, hi = price * 0.09, eps = 1e-9;
    if (side === "롱") {
      const dist = clamp(Math.max(1.3 * atr, price - low10 * 0.998), lo, hi), resistance = Math.max(high40, bars.at(-1).h);
      const breakout = !(resistance > price * 1.005 * (1 + eps));
      const target = breakout ? price + Math.max(swing, 2 * atr) : resistance;
      return {stop: price - dist, target, rr: (target - price) / dist};
    }
    const dist = clamp(Math.max(1.3 * atr, high10 * 1.002 - price), lo, hi), support = Math.min(low40, bars.at(-1).l);
    const breakdown = !(support < price * 0.995 * (1 - eps));
    const drop = clamp(Math.max(swing / high40, 2 * atr / price), 0, 0.9);
    const target = breakdown ? price * (1 - drop) : support;
    return {stop: price + dist, target, rr: (price - target) / dist};
  }

  // ---------------- 유니버스 ----------------
  function selectUniverse(exchangeInfo, tickers, topN) {
    const ok = new Map(exchangeInfo.filter(s => s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING" &&
      !STABLE_BASES.has(s.baseAsset) && (s.underlyingType ?? "COIN") === "COIN" && !(s.underlyingSubType || []).includes("PREMARKET")).map(s => [s.symbol, s]));
    return tickers.filter(t => ok.has(t.symbol)).map(t => ({symbol: t.symbol, base: ok.get(t.symbol).baseAsset, quote_volume: +t.quoteVolume}))
      .sort((a, b) => b.quote_volume - a.quote_volume).slice(0, topN);
  }
  const upbitBase = base => base.replace(/^(1000000|1000|1M)/, "");

  // ---------------- squeeze.py: 응축 스코어 / 거래량 폭발 ----------------
  const MIN_BARS = 140, CLV_RANK_BARS = 500, SPIKE_MULT = 3.0, SPIKE_MAX_AGE = 2, SPIKE_MAX_RISK = 0.15;
  const stdev = xs => { const m = sum(xs) / xs.length; return Math.sqrt(sum(xs.map(x => (x - m) ** 2)) / xs.length); };
  function prank(series, i, n) {  // Pine ta.percentrank
    const prev = series.slice(i - n, i);
    if (i < n || series[i] == null || prev.some(x => x == null)) return null;
    return prev.filter(x => x <= series[i]).length / n * 100;
  }
  // bars: [{open,high,low,close,value}] 마지막 봉 기준. 봉이 모자라면 null
  function squeezeScore(bars) {
    if (bars.length < MIN_BARS) return null;
    const c = bars.map(b => b.close), h = bars.map(b => b.high), lo = bars.map(b => b.low), v = bars.map(b => b.value), n = bars.length, i = n - 1;
    const tr = [h[0] - lo[0], ...range(1, n).map(k => Math.max(h[k] - lo[k], Math.abs(h[k] - c[k - 1]), Math.abs(lo[k] - c[k - 1])))];
    const atr = sum(tr.slice(-14)) / 14;
    const bbw = new Array(n).fill(null);
    for (let k = 19; k < n; k++) { const w = c.slice(k - 19, k + 1), m = sum(w) / 20; bbw[k] = m ? 4 * stdev(w) / m : null; }
    const sqz = (p => p != null && p <= 30)(prank(bbw, i, 120));
    const clv = range(0, n).map(k => h[k] === lo[k] ? 0 : ((c[k] - lo[k]) - (h[k] - c[k])) / (h[k] - lo[k]));
    const clv10 = new Array(n).fill(null);
    for (let k = 9; k < n; k++) { const vs = sum(v.slice(k - 9, k + 1)); clv10[k] = vs ? sum(range(k - 9, k + 1).map(j => clv[j] * v[j])) / vs : 0; }
    const hiClv = (p => p != null && p >= 90)(prank(clv10, i, Math.min(CLV_RANK_BARS, n - 10)));
    const level = Math.max(...h.slice(-20)), nearHi = atr > 0 && (level - c.at(-1)) / atr <= 1.0;
    const obv = [0]; let acc = 0;
    for (let k = 1; k < n; k++) { acc += (c[k] > c[k - 1] ? v[k] : 0) - (c[k] < c[k - 1] ? v[k] : 0); obv.push(acc); }
    const vs = sum(v.slice(-20)), obvUp = vs > 0 && (obv.at(-1) - obv.at(-21)) / vs > 0.1;
    const flags = {sqz, hi_clv: hiClv, near_hi: nearHi, obv_up: obvUp};
    return {score: Object.values(flags).filter(Boolean).length, ...flags, level, atr};
  }
  function volumeSpike(bars, mult = SPIKE_MULT, maxAge = SPIKE_MAX_AGE) {
    const n = bars.length;
    if (n < 40) return null;
    for (let age = 0; age <= maxAge; age++) {
      const j = n - 1 - age, b = bars[j], avg = sum(bars.slice(j - 20, j).map(x => x.value)) / 20;
      if (avg <= 0 || b.value < mult * avg || b.close <= b.open) continue;
      const atr = sum(range(j - 13, j + 1).map(k => Math.max(bars[k].high - bars[k].low, Math.abs(bars[k].high - bars[k - 1].close), Math.abs(bars[k].low - bars[k - 1].close)))) / 14;
      const entry = b.close, stop = Math.min(...bars.slice(j - 19, j + 1).map(x => x.low)) - 0.2 * atr, risk = entry - stop;
      if (risk > 0 && risk / entry <= SPIKE_MAX_RISK) return {age, entry, stop, risk_pct: risk / entry * 100, trail: 4 * atr, vol_x: b.value / avg};
    }
    return null;
  }

  return {parseKlines, ichimokuTrend, flowScore, positioning, decide, blocks, liquidity, tradePlan, selectUniverse, upbitBase, squeezeScore, volumeSpike};
});
