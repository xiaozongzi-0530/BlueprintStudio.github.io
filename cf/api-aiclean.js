/* 定时清理 AI 生成资产（超过 3 天自动删除）
   ------------------------------------------------------------
   Cloudflare：由 Cron Trigger 每天调用 /api/aiclean，带 header X-Clean-Secret。
   也支持管理员带 token 手动 GET 触发。
*/
import { json, verifyToken, ADMIN_EMAIL } from "./_lib.js";
import { cleanExpired } from "./_aistore.js";

export default async (req) => {
  /* Cron 触发：用共享密钥；手动触发：管理员 token */
  const cronSecret = process.env.CLEAN_SECRET;
  const headerSecret = req.headers.get("x-clean-secret") || "";
  const isCron = cronSecret && headerSecret === cronSecret;
  if (!isCron) {
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
