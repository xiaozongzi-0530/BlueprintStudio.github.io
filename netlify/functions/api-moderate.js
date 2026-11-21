/* /api/moderate —— AI 自动违规内容判定（智谱 GLM，免费模型 glm-4-flash）
   ------------------------------------------------------------
   POST JSON {kind, text}   kind: forum | note | chat | discover
   返回 {ok, clean, category, reason}
   - 判定违规时 clean=false，reason 是给用户看的一句话理由
   - 内容只用于判定，本接口不存储任何用户内容
   - 未配置 GLM_API_KEY 时放行（skipped=true），不影响站点可用性
   - 误判走 /api/appeal 人工申诉

   环境变量（Netlify Site settings → Environment variables）：
     GLM_API_KEY   智谱开放平台 API Key（https://open.bigmodel.cn）
*/
import { json, preflight, clientIP, rateLimit } from "./_lib.js";
import { judge } from "./_glm.js";

export const config = { path: "/api/moderate" };

const MAX_TEXT = 6000;

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ ok: false, msg: "只支持 POST" }, 405);

  const ip = clientIP(req);
  /* 20 次/分钟：正常发帖足够，防拿这里刷 GLM 接口 */
  if (!rateLimit("mod", ip, 20, 60 * 1000)) {
    return json({ ok: false, msg: "操作太频繁，请一分钟后再试" }, 429);
  }

  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, msg: "JSON 解析失败" }, 400); }
  const text = String(body.text || "").slice(0, MAX_TEXT);
  if (!text.trim()) return json({ ok: true, clean: true, reason: "内容为空，无需审核" });

  const apiKey = process.env.GLM_MODERATE_KEY || process.env.GLM_API_KEY;
  if (!apiKey) {
    /* 审核服务未配置：放行但打标记，方便前端提示管理员 */
    return json({ ok: true, clean: true, skipped: true, reason: "审核服务未配置" });
  }

  try {
    const v = await judge(apiKey, "publish", text);
    return json(Object.assign({ ok: true }, v));
  } catch (e) {
    /* GLM 挂了/超时：放行，宁可放过不可把站点卡死 */
    return json({ ok: true, clean: true, skipped: true, reason: "审核服务暂时不可用：" + String(e.message || "").slice(0, 80) });
  }
};
