/* 차트 지표(EMA·RSI·MACD·볼린저)와 그리기 도구(피보나치·사각형) 계산. 브라우저(전역 CL)와 Node(require) 겸용 순수 JS. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CL = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // 처음 n개의 평균에서 시작(첫 값 시드 편향 없음). n-1번째 인덱스 전은 null
  function emaSeries(values, n) {
    const out = new Array(values.length).fill(null);
    if (values.length < n) return out;
    const k = 2 / (n + 1);
    let e = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
    out[n - 1] = e;
    for (let i = n; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }

  // Wilder RSI. 앞 n개는 null, 손실이 0이면 100
  function rsiSeries(closes, n = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length < n + 1) return out;
    const d = closes.slice(1).map((c, i) => c - closes[i]);
    let gain = d.slice(0, n).reduce((a, x) => a + Math.max(x, 0), 0) / n;
    let loss = d.slice(0, n).reduce((a, x) => a + Math.max(-x, 0), 0) / n;
    const rsi = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
    out[n] = rsi();
    for (let i = n; i < d.length; i++) {
      gain = (gain * (n - 1) + Math.max(d[i], 0)) / n;
      loss = (loss * (n - 1) + Math.max(-d[i], 0)) / n;
      out[i + 1] = rsi();
    }
    return out;
  }

  // MACD(12,26,9): macd는 slow-1번째부터, signal은 그로부터 signal-1봉 뒤부터
  function macdSeries(closes, fast = 12, slow = 26, signal = 9) {
    const f = emaSeries(closes, fast), s = emaSeries(closes, slow);
    const macd = closes.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
    const first = macd.findIndex(v => v != null);
    const sig = new Array(closes.length).fill(null);
    if (first >= 0) emaSeries(macd.slice(first), signal).forEach((v, j) => { sig[first + j] = v; });
    const hist = macd.map((m, i) => (m == null || sig[i] == null ? null : m - sig[i]));
    return {macd, signal: sig, hist};
  }

  // 볼린저: SMA ± k × 모표준편차
  function bollingerSeries(closes, n = 20, k = 2) {
    const mid = new Array(closes.length).fill(null), upper = mid.slice(), lower = mid.slice();
    for (let i = n - 1; i < closes.length; i++) {
      const w = closes.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / n;
      const sd = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / n);
      mid[i] = m; upper[i] = m + k * sd; lower[i] = m - k * sd;
    }
    return {mid, upper, lower};
  }

  // null 구간은 값 없는 점({time})으로 남긴다: 모든 차트의 봉 수가 같아야 논리 인덱스 기준 시간축 동기화가 어긋나지 않는다
  const toSeries = (candles, vals) => candles.map((c, i) => (vals[i] == null ? {time: c.time} : {time: c.time, value: vals[i]}));

  // 피보나치 되돌림: 끝점(p2)이 0%, 시작점(p1)이 100%
  const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const fibLevels = (p1, p2) => FIB_RATIOS.map(ratio => ({ratio, price: p2 + (p1 - p2) * ratio, major: [0, 0.5, 0.618, 1].includes(ratio)}));

  // 사각형: 시간·가격 정렬. 같은 시각이면 면적이 없으므로 null
  function rectBounds(t1, p1, t2, p2) {
    if (t1 === t2) return null;
    return {t1: Math.min(t1, t2), t2: Math.max(t1, t2), low: Math.min(p1, p2), high: Math.max(p1, p2)};
  }

  // 클릭한 시각을 가장 가까운 봉 시각에 붙인다
  function snapTime(times, t) {
    if (!times.length) return null;
    return times.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), times[0]);
  }

  // 라이브러리는 시각을 UTC로만 보여준다: 사용자 시간대(분 단위 오프셋, 동쪽이 +)로 바꿔 표시한다
  const pad = n => String(n).padStart(2, "0");
  const localOffset = () => -new Date().getTimezoneOffset();
  function fmtLocal(t, off = localOffset()) {
    const d = new Date((t + off * 60) * 1000);
    return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function tickLabel(t, type, off = localOffset()) {  // type: 0 연, 1 월, 2 일, 3·4 시각
    const d = new Date((t + off * 60) * 1000);
    return type === 0 ? String(d.getUTCFullYear()) : type === 1 ? `${d.getUTCMonth() + 1}월` : type === 2 ? `${d.getUTCDate()}일`
      : `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  // 불러온 봉보다 과거 시각에 걸친 그림은 범위 밖(그리면 시간축이 왜곡되거나 사라진다)
  const inRange = (d, first) => d.kind === "hline" || (d.data.t1 >= first && d.data.t2 >= first);

  // 가격 입력 해석: 천 단위 쉼표 허용, 일부만 숫자인 입력("12abc")은 거부
  const num = x => { const v = Number(x); return Number.isFinite(v) && v > 0 && String(x).trim() !== "" ? v : null; };
  const parsePrice = s => num(String(s).trim().replace(/,/g, ""));
  function parsePrices(s) {
    const parts = String(s).trim().replace(/,/g, "").split(/\s+/);
    if (parts.length !== 2) return null;
    const v = parts.map(num);
    return v.every(x => x != null) ? v : null;
  }

  return {fmtLocal, tickLabel, inRange, parsePrice, parsePrices, emaSeries, rsiSeries, macdSeries, bollingerSeries, toSeries, fibLevels, FIB_RATIOS, rectBounds, snapTime};
});
