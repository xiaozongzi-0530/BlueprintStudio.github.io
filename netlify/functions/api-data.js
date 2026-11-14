/* /api/data —— 通用数据接口（替代 textdb.dev 公开 KV）
   GET  ?key=xxx          公开读（与旧 textdb 相同的公开程度）
   POST {key, data}       写入：
                            - users 库禁止经由此接口（只能走 /api/auth）
                            - announce 库仅管理员 token 可写
                            - 其余 UGC 库：登录 token 可写；游客无 token 也可写（与旧行为一致），
                              但限流更严
   兼容说明：请求/响应体与旧 textdb 格式完全一致，前端只需换 URL */
import { getStore } from "@netlify/blobs";
import { json, preflight, clientIP, rateLimit, verifyToken, GUEST_WRITABLE, ADMIN_ONLY } from "./_lib.js";

export const config = { path: "/api/data" };

const store = () => getStore("data");

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();

  if (req.method === "GET") {
    const key = new URL(req.url).searchParams.get("key") || "";
    if (!/^blueprintstudio-[a-z0-9-]+$/.test(key)) return json({ ok: false, msg: "key 不合法" }, 400);
    const raw = await store().get(key);
    return new Response(raw === null ? "{}" : raw, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (req.method !== "POST") return json({ ok: false, msg: "只支持 GET/POST" }, 405);

  const ip = clientIP(req);
  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, msg: "JSON 解析失败" }, 400); }
  const key = body.key || "";
  if (!/^blueprintstudio-[a-z0-9-]+$/.test(key)) return json({ ok: false, msg: "key 不合法" }, 400);

  /* users 库是账号体系，只允许 /api/auth 触碰 */
  if (key === "blueprintstudio-users-v2") return json({ ok: false, msg: "用户库只能通过账号接口操作" }, 403);

  const tok = await verifyToken(req);

  if (ADMIN_ONLY.has(key) && (!tok || !tok.admin)) {
    return json({ ok: false, msg: "需要管理员权限" }, 403);
  }
  if (!tok) {
    /* 游客写：仅 UGC 库，且限流收紧到 12 次/分钟/IP */
    if (!GUEST_WRITABLE.has(key)) return json({ ok: false, msg: "该库需要登录后操作" }, 401);
    if (!rateLimit("gw", ip, 12, 60 * 1000)) return json({ ok: false, msg: "操作太频繁，请稍后再试" }, 429);
  } else {
    if (!rateLimit("dw", ip, 60, 60 * 1000)) return json({ ok: false, msg: "操作太频繁，请稍后再试" }, 429);
  }

  const data = typeof body.data === "string" ? body.data : JSON.stringify(body.data);
  /* 单库上限 8MB（旧 textdb 约 2MB，放宽以容纳更多内容） */
  if (data.length > 8 * 1024 * 1024) return json({ ok: false, msg: "数据过大（上限 8MB）" }, 413);
  await store().set(key, data);
  return json({ ok: true });
};
