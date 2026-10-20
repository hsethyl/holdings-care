# 보유종목 케어 (모바일 정적판)

`trading-assistant`(localhost:8800)의 대시보드를 서버 없이 GitHub Pages에서 돌리는 버전.
업비트·바이낸스 공개 API를 브라우저가 직접 호출하고, 보유·관심종목·선은 이 기기 localStorage에만 저장한다.

포함: 보유종목 점검, 관심종목·분석, 차트(그리기 도구), 롱/숏 스캔, 거래량 폭발 스캔, 응축 스캔, 실시간 호가·체결.
제외: 뉴스·신호 성적표·백테스트(서버·DB 필요), 주식(한국투자증권 키 필요), 텔레그램 알림.

- `js/` 원본 파이썬(rules·indicators·flow·analysis·scan·squeeze) 포팅 + `/api/*`를 브라우저에서 처리하는 api.js
- `tools/build.py` 원본 dashboard.html에서 index.html 생성 (원본은 수정하지 않음)
- 검증: `python tools/make_fixtures.py && node tools/compare.js` — 원본 파이썬과 같은 입력으로 출력 대조

## 업비트 프록시(Cloudflare Worker) 설정
업비트는 웹 출처(github.io)의 요청을 분당 10회(출처 전체 합산)로 막는다. 업비트 REST가 필요한 기능을 쓰려면 `worker/upbit-proxy.js`를 무료 Cloudflare Worker로 배포한다.
1. dash.cloudflare.com → Workers & Pages → Create → Hello World → Deploy → Edit code
2. 기본 코드를 지우고 `worker/upbit-proxy.js` 전체를 붙여넣기 → Deploy
3. 나온 주소(`https://....workers.dev`)를 `config.js`의 `upbitProxy`에 넣어 커밋하거나, 폰에서 `https://hsethyl.github.io/holdings-care/?proxy=https://....workers.dev`를 한 번 열면 그 기기에 저장된다.
