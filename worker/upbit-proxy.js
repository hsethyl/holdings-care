// 업비트는 github.io 같은 웹 출처의 요청을 "분당 10회(출처 전체 합산)"로 막는다. 이 Worker가 대신 호출해 준다.
// Origin 헤더 없이 업비트로 나가므로 일반 IP 한도(초당 10회 안팎)를 적용받는다. 허용한 사이트 외에는 쓸 수 없다.
const ALLOW = ["https://hsethyl.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
const PATHS = /^(candles\/(days|minutes\/(1|3|5|10|15|30|60|240))|ticker|orderbook|trades\/ticks|market\/all)$/;

export default {
  async fetch(req) {
    const origin = req.headers.get("Origin") || "";
    const cors = {"Access-Control-Allow-Origin": ALLOW.includes(origin) ? origin : ALLOW[0], "Vary": "Origin"};
    if (req.method === "OPTIONS") return new Response(null, {headers: {...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400"}});
    if (req.method !== "GET" || !ALLOW.includes(origin)) return new Response("forbidden", {status: 403, headers: cors});
    const u = new URL(req.url), path = u.pathname.replace(/^\/+/, "");
    if (!PATHS.test(path)) return new Response("not found", {status: 404, headers: cors});
    const ttl = path.startsWith("candles/") ? 20 : 2;  // 같은 요청이 몰려도 업비트에는 한 번만 간다
    const r = await fetch(`https://api.upbit.com/v1/${path}${u.search}`, {headers: {Accept: "application/json"}, cf: {cacheEverything: true, cacheTtl: ttl}});
    return new Response(r.body, {status: r.status, headers: {...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttl}`}});
  },
};
