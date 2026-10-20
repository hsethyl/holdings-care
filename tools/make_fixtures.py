"""원본(trading-assistant) 파이썬 계산을 라이브 데이터로 돌려 입력과 기대값을 fixtures.json에 저장한다.
node tools/compare.js 가 같은 입력으로 js/*.js 결과를 대조한다. 실행: python tools/make_fixtures.py"""
import json, os, sys, time
from dataclasses import asdict, is_dataclass

import requests

sys.path.insert(0, os.environ.get("TA_DIR", r"C:\Users\hseth\trading-assistant"))
import scan as S
from analysis import analyze
from flow import analyze_flow, Book, Trade
from rules import Candle, Position, evaluate
from sources import Upbit, parse_upbit_candles, parse_upbit_orderbook, parse_upbit_trades
from squeeze import squeeze_score, volume_spike

UP, BN = "https://api.upbit.com/v1", "https://fapi.binance.com"
TODAY = "2026-10-20"
get = lambda url, **p: requests.get(url, params=p, timeout=15).json()


def plain(o):
    if is_dataclass(o):
        o = asdict(o)
    if isinstance(o, dict):
        return {k: plain(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [plain(v) for v in o]
    return o


out = {"holdings": [], "analysis": [], "scan": [], "squeeze": [], "positioning": [], "universe": None}
up = Upbit()

# --- 업비트: 보유 판정 + 종목 분석(+수급)
for m in ["KRW-BTC", "KRW-XRP", "KRW-ETH", "KRW-DOGE", "KRW-SOL", "KRW-SUI", "KRW-ADA"]:
    rows = get(f"{UP}/candles/days", market=m, count=200)
    rows += get(f"{UP}/candles/days", market=m, count=200, to=rows[-1]["candle_date_time_utc"] + "Z")
    candles = parse_upbit_candles(rows)
    closed = [c for c in candles if c.ts < TODAY]
    last = closed[-1].close
    for mult, stage, floor in [(1.0, 0, 0), (0.93, 0, 0), (1.12, 0, 0), (1.3, 1, 0), (0.99, 1, last * 0.97)]:
        pos = Position(m, "coin", last, 1, closed[-12].ts, stage, floor)
        out["holdings"].append({"rows": rows, "pos": asdict(pos), "price": last * mult, "expect": plain(evaluate(pos, candles, last * mult, TODAY))})
    ob, tk = get(f"{UP}/orderbook", markets=m), get(f"{UP}/trades/ticks", market=m, count=200)
    price = float(get(f"{UP}/ticker", markets=m)[0]["trade_price"])
    flow = analyze_flow(parse_upbit_orderbook(ob), parse_upbit_trades(tk), "coin")
    for use_flow, req in [(True, True), (False, False), (False, True)]:
        try:
            exp = plain(analyze(candles, price, "coin", TODAY, flow=flow if use_flow else None, require_flow=req))
        except Exception as e:
            exp = {"error": str(e)}
        out["analysis"].append({"rows": rows, "ob": ob, "tk": tk, "price": price, "use_flow": use_flow, "req": req, "expect": exp, "flow_expect": plain(flow)})
    # 가격을 바꿔 BUY/AVOID 분기도 건드린다
    for mult in (0.9, 1.15):
        exp = plain(analyze(candles, price * mult, "coin", TODAY, flow=None, require_flow=False))
        out["analysis"].append({"rows": rows, "ob": ob, "tk": tk, "price": price * mult, "use_flow": False, "req": False, "expect": exp, "flow_expect": None})

# --- 바이낸스: 롱/숏 스캔 조각
info = get(f"{BN}/fapi/v1/exchangeInfo")["symbols"]
tick = get(f"{BN}/fapi/v1/ticker/24hr")
uni = S.select_universe(info, tick, 12)
out["universe"] = {"info": info, "tick": tick, "n": 12, "expect": uni}
fx = float(get(f"{UP}/ticker", markets="KRW-USDT")[0]["trade_price"])
for coin in uni:
    sym = coin["symbol"]
    for iv, ms in (("1h", 3600e3), ("4h", 4 * 3600e3)):
        rows = get(f"{BN}/fapi/v1/klines", symbol=sym, interval=iv, limit=120)
        d = get(f"{BN}/fapi/v1/depth", symbol=sym, limit=100)
        bids, asks = [(float(p), float(q)) for p, q in d["bids"]], [(float(p), float(q)) for p, q in d["asks"]]
        bars = S.parse_klines(rows)
        closed, cur = bars[:-1], bars[-1]
        frac = max(0.005, min(1.0, (time.time() * 1000 - cur.t) / ms))
        b20, a20 = sum(p * q for p, q in bids[:20]), sum(p * q for p, q in asks[:20])
        ob = (b20 - a20) / (b20 + a20) if b20 + a20 > 0 else None
        flow = S.flow_score(bars, frac, fx, ob)
        T, why = S.ichimoku_trend(closed)
        liq = S.liquidity(bids, asks, 10000.0)
        plans = {side: S.trade_plan(side, bars, cur.c) for side in ("롱", "숏")}
        out["scan"].append({"rows": rows, "depth": d, "frac": frac, "fx": fx, "ob": ob,
                            "expect": {"flow": plain(flow), "T": T, "why": why, "liq": liq, "plans": plans,
                                       "blocks": [S.blocks(dec, coin["quote_volume"] * fx, plans["롱"]["rr"], frac) for dec in ("롱", "숏", "없음")]}})

# --- P/decide: 격자
for fp in (None, -0.08, -0.03, 0.0, 0.03, 0.08):
    for oi in (None, 2.0, 8.0):
        for pc in (None, -1.0, 3.0):
            for ls in (None, 0.5, 1.0, 2.5):
                for tk_ in (None, 0.7, 1.0, 1.3):
                    out["positioning"].append({"a": [fp, oi, pc, ls, tk_], "expect": plain(S.positioning(fp, oi, pc, ls, tk_))})
out["decide"] = [{"a": [F, T, P], "expect": S.decide(F, T, P)} for F in (None, 30, 50, 70) for T in (None, 30, 50, 70) for P in (None, -1, 0, 1)]

# --- 응축 / 거래량 폭발 (업비트 KRW 마켓 4h·1h 봉, 신호가 잡히는 종목을 우선 포함)
mkts = [m["market"] for m in get(f"{UP}/market/all") if m["market"].startswith("KRW-")]
tk = {t["market"]: t for t in get(f"{UP}/ticker", markets=",".join(mkts))}
liquid = [m for m in mkts if tk[m]["acc_trade_price_24h"] > 3e9][:60]
for m in liquid:
    for iv in ("4h", "1h"):
        time.sleep(0.12)
        bars = up.chart_candles(m, iv, 520)[:-1]
        out["squeeze"].append({"bars": bars, "expect": {"sq": plain(squeeze_score(bars)), "sp": plain(volume_spike(bars[-59:]))}})
        # 폭발 조건을 확실히 건드리도록 마지막 봉 거래량을 키운 변형도 만든다
        b2 = [dict(b) for b in bars[-59:]]
        b2[-1]["value"] *= 6
        b2[-1]["close"] = max(b2[-1]["close"], b2[-1]["open"] * 1.01)
        out["squeeze"].append({"bars": b2, "expect": {"sq": None, "sp": plain(volume_spike(b2))}})

json.dump(out, open(os.path.join(os.path.dirname(__file__), "fixtures.json"), "w", encoding="utf-8"))
print({k: len(v) if isinstance(v, list) else 1 for k, v in out.items()})
