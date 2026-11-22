/* BlueprintStudio · Cloudflare Worker 主入口
   ------------------------------------------------------------
   - 按 /api/<name> 路由分发到各后端函数
   - 注入 KV 适配层（setKV）与环境变量（process.env 模拟）
   - 静态资源由 Workers Assets / Pages 提供，此处只处理 /api/*
*/
import { setKV } from "./_blobs.js";
import apiAuth from "./api-auth.js";
import apiData from "./api-data.js";
import apiModerate from "./api-moderate.js";
import apiReport from "./api-report.js";
import apiAppeal from "./api-appeal.js";
import apiAicode from "./api-aicode.js";
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
  "/api/ai": apiAi,
  "/api/aiclean": apiAiclean,
  "/api/file": apiFile,
  "/api/migrate": apiMigrate,
};

export default {
  async fetch(request, env, ctx) {
    // 注入 KV 与环境变量（函数里用 process.env.XXX）
    setKV(env.BP_DATA);
    globalThis.process = globalThis.process || {};
    globalThis.process.env = env;

    const url = new URL(request.url);
    const handler = ROUTES[url.pathname];
    if (handler) {
      try {
        return await handler(request, env, ctx);
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, msg: "服务器内部错误", err: String(e && e.message || e) }), {
          status: 500, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
        });
      }
    }
    // 非 API 路径交给静态资源 Assets（由 wrangler assets 处理，这里兜底）
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
  },

  // Cron Trigger：每天清理过期 AI 资产
  async scheduled(controller, env, ctx) {
    setKV(env.BP_DATA);
    globalThis.process = globalThis.process || {};
    globalThis.process.env = env;
    ctx.waitUntil(
      cleanExpired(Date.now())
        .then(r => console.log("aiclean:", JSON.stringify(r)))
        .catch(e => console.error("aiclean failed:", e))
    );
  },
};
