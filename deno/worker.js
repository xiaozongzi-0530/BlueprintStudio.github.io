/* BlueprintStudio · Deno Deploy 主入口
   ------------------------------------------------------------
   - 按 /api/<name> 路由分发到各后端函数
   - 注入 Deno KV 适配层与环境变量（process.env 模拟）
   - 静态资源由 public/ 目录提供（可选，主要静态仍走 GitHub Pages）
   - 每天定时清理过期 AI 资产
*/
import { setKV } from "./_blobs.js";
import apiAuth from "./api-auth.js";
import apiData from "./api-data.js";
import apiModerate from "./api-moderate.js";
import apiReport from "./api-report.js";
import apiAppeal from "./api-appeal.js";
import apiAicode from "./api-aicode.js";
import apiVip from "./api-vip.js";
import apiAi from "./api-ai.js";
import apiAiclean from "./api-aiclean.js";
import apiFile from "./api-file.js";
import apiMigrate from "./api-migrate.js";
import { cleanExpired } from "./_aistore.js";

const ROUTES = {
  "/api/auth": apiAuth,
  "/api/data": apiData,
  "/api/moderate": apiModerate,
  "/api/report": apiReport,
  "/api/appeal": apiAppeal,
  "/api/aicode": apiAicode,
  "/api/vip": apiVip,
  "/api/ai": apiAi,
  "/api/aiclean": apiAiclean,
  "/api/file": apiFile,
  "/api/migrate": apiMigrate,
};

/* 初始化一次 KV 与环境变量；Deno Deploy 用 Deno.env.get 读 secrets
   本地测试可用 KV_PATH 指定本地 KV 文件；部署到 Deno Deploy 时不设即用托管 KV */
const kvPath = Deno.env.get("KV_PATH");
const kv = kvPath ? await Deno.openKv(kvPath) : await Deno.openKv();
setKV(kv);
globalThis.process = globalThis.process || {};
globalThis.process.env = {
  GLM_API_KEY: Deno.env.get("GLM_API_KEY") || "",
  GLM_MODERATE_KEY: Deno.env.get("GLM_MODERATE_KEY") || "",
  CLEAN_SECRET: Deno.env.get("CLEAN_SECRET") || "",
  JWT_SECRET: Deno.env.get("JWT_SECRET") || "",
  SMTP_USER: Deno.env.get("SMTP_USER") || "",
  SMTP_PASS: Deno.env.get("SMTP_PASS") || "",
};

/* 简单静态资源映射：把请求路径映射到本地 public/ 文件 */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};
async function serveStatic(req) {
  try {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "") p = "/index.html";
    // 去掉开头 /，拼到 public 下；防目录穿越
    const rel = p.replace(/^\/+/, "");
    const path = await import("node:path");
    const safe = path.normalize("public/" + rel).replace(/^(\.\.[\/\\])+/, "");
    if (!safe.startsWith("public/")) return new Response("Forbidden", { status: 403 });
    const data = await Deno.readFile(safe);
    const ext = safe.slice(safe.lastIndexOf("."));
    return new Response(data, { headers: { "Content-Type": MIME[ext] || "application/octet-stream" } });
  } catch (_e) {
    return new Response("Not Found", { status: 404 });
  }
}

/* 每天 UTC 03:00 自动清理超过 3 天的 AI 资产（替代 CF 的 Cron Trigger） */
Deno.cron("clean-expired-ai-assets", "0 3 * * *", async () => {
  try {
    const r = await cleanExpired(Date.now());
    console.log("aiclean:", JSON.stringify(r));
  } catch (e) {
    console.error("aiclean failed:", e);
  }
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const handler = ROUTES[url.pathname];
  if (handler) {
    try {
      return await handler(req);
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, msg: "服务器内部错误", err: String((e && e.message) || e) }), {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      });
    }
  }
  return serveStatic(req);
});
