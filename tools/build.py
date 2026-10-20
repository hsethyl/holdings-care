"""trading-assistant/dashboard.html(+dashboard_mobile.html의 모바일 CSS)을 읽기만 해서 정적 페이지 index.html을 만든다.
원본은 수정하지 않는다. 서버가 필요한 구역(뉴스·신호 성적표·백테스트)과 주식 입력은 뺀다.
원본이 바뀐 뒤 다시 반영: python tools/build.py"""
import os

TA = os.environ.get("TA_DIR", r"C:\Users\hseth\trading-assistant")
here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rd = lambda p: open(os.path.join(TA, p), encoding="utf-8").read()
s = rd("dashboard.html")


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, (s.count(old), old[:70])
    s = s.replace(old, new)


def cut(start, end, keep_end=True, new=""):
    """start 문자열부터 end 직전(keep_end)까지 잘라 new로 바꾼다."""
    global s
    i = s.index(start)
    j = s.index(end, i) + (0 if keep_end else len(end))
    s = s[:i] + new + s[j:]


# 1) 모바일 메타 + 제목
rep('<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
    '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="보유케어">\n'
    '<meta name="mobile-web-app-capable" content="yes">')

# 2) 서버 없이 도는 api 계층으로 교체 (원본 계약 /api/* 그대로)
rep('<script src="/vendor/lightweight-charts.js"></script>\n<script src="/static/flowlib.js"></script>\n<script src="/static/chartlib.js"></script>',
    '<script src="vendor/lightweight-charts-4.2.0.js"></script>\n<script src="static/flowlib.js"></script>\n<script src="static/chartlib.js"></script>\n'
    '<script src="js/rules.js"></script>\n<script src="js/ind.js"></script>\n<script src="js/scan.js"></script>\n<script src="js/api.js"></script>')
i = s.index("const api = (url, method")
j = s.index("r.json(); });", i) + len("r.json(); });")
s = s[:i] + "const api = HC_API.api;  // 서버 대신 브라우저에서 업비트·바이낸스를 직접 호출(js/api.js)" + s[j:]

# 3) 서버가 필요한 구역 제거: 뉴스, 신호 성적표, 백테스트
cut('<h2>신호 성적표</h2>', '<div id="rtbox" hidden>')
cut("// 새로 들어온 중요 뉴스 수", "const VERDICT =")
cut("// ---- 신호 성적표 / 백테스트", "load(); loadWatch();")
rep("load(); loadWatch(); loadNews().catch(() => {}); setInterval(load, 15000); setInterval(() => loadNews().catch(() => {}), 60000);",
    "load(); loadWatch(); setInterval(load, 15000);")

# 4) 주식은 한국투자증권 키(서버)가 필요해 제외
rep('<option value="coin">코인</option><option value="stock">주식</option>', '<option value="coin">코인</option>', count=2)
rep('placeholder="KRW-BTC 또는 005930"', 'placeholder="BTC 또는 KRW-BTC"')

# 5) 일부 매도(TRIM)도 확인 버튼으로 단계를 래치(텔레그램 알림이 없으므로 화면이 유일한 알림)
rep('if (h.alert && h.alert.status.startsWith("EXIT") && !h.alert.acked) btn(act, "확인"',
    'if (h.alert && /^(EXIT|TRIM)/.test(h.alert.status) && !h.alert.acked) btn(act, "확인"')

# 6) 모바일 CSS: dashboard_mobile.html에 이미 있는 블록을 그대로 쓴다
m = rd("dashboard_mobile.html")
css = m[m.index("/* ===== v2 모바일"):m.index("</style>")]
rep("</style>", css + "</style>")

# 7) 화면 안내
rep("텔레그램 미설정: 알림은 이 화면에서만 확인됩니다. 이 창을 열어 두고, 탭 제목의 🚨 표시를 확인하세요.",
    "이 모바일판은 텔레그램 알림이 없습니다. 화면을 열어 둘 때만 15초마다 점검하며, 전량 매도 경보는 탭 제목의 🚨와 카드 색으로 표시됩니다. 보유·관심종목·선은 이 기기 브라우저에만 저장됩니다.")

open(os.path.join(here, "index.html"), "w", encoding="utf-8").write(s)
print("ok", len(s), "bytes")
