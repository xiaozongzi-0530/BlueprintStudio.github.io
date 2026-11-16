/* 定时清理 AI 生成资产（超过 3 天自动删除）
   ------------------------------------------------------------
   Netlify Scheduled Function：需在 netlify.toml 配置 schedule。
   也支持手动 GET 触发（需管理员 token），便于立即清理。
*/
import { json, verifyToken, ADMIN_EMAIL } from "./_lib.js";
import { cleanExpired } from "./_aistore.js";

export const config = { path: "/api/aiclean", schedule: "0 3 * * *" };  // 每天 03:00 UTC

export default async (req) => {
  /* 定时触发：Netlify 调用时无用户身份，直接执行；
     HTTP 手动触发：仅管理员可调用 */
  const isInvoke = req.headers.get("x-nf-event-type") === "schedule" || req.headers.get("user-agent", "").indexOf("Netlify") !== -1;
  if (!isInvoke && req.method === "GET") {
    const tok = await verifyToken(req);
    if (!tok || tok.email !== ADMIN_EMAIL) return json({ ok: false, msg: "仅管理员可执行" }, 403);
  }
  try {
    const result = await cleanExpired(Date.now());
    return json({ ok: true, ...result });
  } catch (e) {
    return json({ ok: false, msg: String(e && e.message || e) }, 500);
  }
};
