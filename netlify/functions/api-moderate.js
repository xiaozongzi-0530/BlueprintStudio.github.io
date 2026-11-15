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

export const config = { path: "/api/moderate" };

const GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4-flash";          // 免费模型，速度够快，适合发帖前实时过审
const MAX_TEXT = 6000;

const SYSTEM_PROMPT = `你是 "BlueprintStudio" 程序员社区的内容审核员。判断提交的内容是否违规。

违规判定标准：
1. 色情低俗、性暗示内容
2. 涉政敏感、危害国家安全或社会稳定的内容
3. 暴力血腥、恐吓威胁、教唆自残
4. 赌博、毒品、枪支等违禁品相关
5. 诈骗、钓鱼、刷单、传销、代考代写
6. 恶意广告、与社区无关的营销引流
7. 侮辱谩骂、人身攻击、地域或群体歧视
8. 泄露他人隐私（手机号、住址、身份证、密码等）
9. 木马病毒、盗版破解、外挂作弊
10. 未成年人相关的不良内容

以下内容一律视为正常，不要误判：
- 技术讨论、代码、报错求助、开源项目介绍
- 日常交流、开玩笑（无人身攻击）、表情
- 站点功能反馈、bug 报告

只输出 JSON，禁止输出其他任何文字：
{"clean": true或false, "category": "违规类别英文标识，正常则留空", "reason": "给用户看的简短中文说明，正常时填：内容正常"}`;

function clamp(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) : s; }

async function callGLM(apiKey, text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(GLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "待审核内容：\n" + text },
        ],
        temperature: 0.05,
        max_tokens: 200,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("GLM HTTP " + r.status);
    const data = await r.json();
    const content = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content || "";
    /* 模型偶尔会包一层 ```json 围栏，剥掉再解析 */
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("GLM 返回无法解析");
    const v = JSON.parse(m[0]);
    return {
      clean: v.clean !== false,
      category: clamp(v.category || "", 40),
      reason: clamp(v.reason || "", 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

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
  const text = clamp(body.text, MAX_TEXT);
  if (!text.trim()) return json({ ok: true, clean: true, reason: "内容为空，无需审核" });

  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) {
    /* 审核服务未配置：放行但打标记，方便前端提示管理员 */
    return json({ ok: true, clean: true, skipped: true, reason: "审核服务未配置" });
  }

  try {
    const v = await callGLM(apiKey, text);
    return json(Object.assign({ ok: true }, v));
  } catch (e) {
    /* GLM 挂了/超时：放行，宁可放过不可把站点卡死 */
    return json({ ok: true, clean: true, skipped: true, reason: "审核服务暂时不可用：" + clamp(e.message, 80) });
  }
};
