/* BlueprintStudio · 腾讯云 CloudBase 云函数统一入口
   ------------------------------------------------------------
   HTTP 访问服务把请求包装成 event：{httpMethod, path, headers,
   queryStringParameters, body, isBase64Encoded}
   本入口把它转成标准 Request，复用与 CF/Deno 版完全相同的 10 个 API，
   再把 Response 转回 CloudBase 需要的 {statusCode, headers, body}。
*/
import apiAuth from "./api-auth.js";
import apiData from "./api-data.js";
import apiModerate from "./api-moderate.js";
import apiReport from "./api-report.js";
import apiAppeal from "./api-appeal.js";
import apiAicode from "./api-aicode.js";
import apiQuota from "./api-quota.js";
import apiAi from "./api-ai.js";
import apiAiclean from "./api-aiclean.js";
import apiFile from "./api-file.js";
import apiMigrate from "./api-migrate.js";

const ROUTES = {
  "/api/auth": apiAuth,
  "/api/data": apiData,
  "/api/moderate": apiModerate,
  "/api/report": apiReport,
  "/api/appeal": apiAppeal,
  "/api/aicode": apiAicode,
  "/api/quota": apiQuota,
  "/api/ai": apiAi,
  "/api/aiclean": apiAiclean,
  "/api/file": apiFile,
  "/api/migrate": apiMigrate,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/* event → 标准 Request */
function toRequest(event) {
  const method = (event.httpMethod || "GET").toUpperCase();
  // 路径：HTTP 访问服务的 path 可能带 /api 前缀，也可能不带（取决于触发路径配置）
  let path = event.path || "/";
  const qs = event.queryStringParameters || {};
  const q = Object.keys(qs).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(qs[k] || "")).join("&");
  const url = "https://cloudbase.local" + path + (q ? "?" + q : "");

  const headers = new Headers();
  const eh = event.headers || {};
  Object.keys(eh).forEach(k => {
    try { headers.set(k, String(eh[k])); } catch (e) {}
  });
  // 客户端 IP：CloudBase 一般在 x-forwarded-for 里
  if (!headers.has("x-forwarded-for") && event.requestContext) {
    const ip = event.requestContext.sourceIp || event.requestContext.clientIp;
    if (ip) headers.set("x-forwarded-for", ip);
  }

  let body = undefined;
  if (event.body != null && event.body !== "") {
    body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  }
  return new Request(url, { method, headers, body: (method === "GET" || method === "HEAD") ? undefined : body });
}

/* Response → CloudBase 结果 */
async function toResult(res) {
  const headers = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  // 确保 CORS
  Object.keys(CORS).forEach(k => { if (!headers[k]) headers[k] = CORS[k]; });
  const buf = await res.arrayBuffer();
  let body;
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const binary = /image\/|application\/octet-stream|video\//.test(ct);
  if (binary) {
    /* CloudBase HTTP 网关约定：二进制放顶层 isBase64Encoded 字段，
       不能塞进 headers（网关不认，会导致 body 丢失 / content-length 不匹配） */
    body = Buffer.from(buf).toString("base64");
    return { statusCode: res.status, headers, body, isBase64Encoded: true };
  }
  body = Buffer.from(buf).toString("utf8");
  return { statusCode: res.status, headers, body };
}

export default async (event) => {
  // OPTIONS 预检
  if ((event.httpMethod || "").toUpperCase() === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }
  const req = toRequest(event);
  let path = new URL(req.url).pathname;
  // HTTP 访问服务路径为 /api，event.path 可能是 /auth（已剥前缀）或 /api/auth
  if (ROUTES[path] === undefined && !path.startsWith("/api/")) path = "/api" + path;
  const handler = ROUTES[path];
  if (!handler) {
    return { statusCode: 404, headers: CORS, body: JSON.stringify({ ok: false, msg: "Not Found" }) };
  }
  try {
    const res = await handler(req);
    return await toResult(res);
  } catch (e) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ ok: false, msg: "服务器内部错误", err: String((e && e.message) || e) }),
    };
  }
};

