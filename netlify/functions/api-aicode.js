/* /api/aicode —— AI 写代码（智谱 GLM，glm-4-flash）
   ------------------------------------------------------------
   POST JSON {prompt, lang, mode, history}
     prompt  需求描述（必填）
     lang    目标语言（可空）
     mode    generate（写代码，默认）| explain（解释代码）| fix（找 bug）
     history 多轮对话上下文 [{role:"user"|"assistant", content:"..."}]（可空，最多取最近 8 条）
   返回 {ok, text}    text 为模型输出（含 markdown 代码块）
   - 服务端代理 GLM，API Key 不下发前端
   - 未配置 GLM_API_KEY 或调用失败时返回明确错误

   环境变量：GLM_API_KEY（已配置）
*/
import { json, preflight, clientIP, rateLimit } from "./_lib.js";
import { GLM_URL, MODEL } from "./_glm.js";

export const config = { path: "/api/aicode" };

const MAX_PROMPT = 3000;
const MAX_OUTPUT = 4000;   // max_tokens

function clamp(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }

const SYSTEM = `你是 "BlueprintStudio" 程序员社区的 AI 编程助手，擅长写代码、解释代码和排查 bug。

要求：
1. 代码放在 markdown 代码块里（\`\`\`语言 ... \`\`\`），并标注语言
2. 代码要完整可运行、有必要的注释（中文注释）
3. 输出结构：先一两句话说明思路，再给代码，最后给关键点提示
4. 解释代码时逐段讲清楚；排查 bug 时指出问题行并给出修复后的完整代码
5. 不写与编程无关的内容；拒绝生成违法违规代码（木马、攻击工具、爬虫绕过反爬等）`;

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ ok: false, msg: "只支持 POST" }, 405);

  const ip = clientIP(req);
  /* 10 次/分钟：防刷 GLM 接口 */
  if (!rateLimit("aicode", ip, 10, 60 * 1000)) {
    return json({ ok: false, msg: "生成太频繁，请一分钟后再试" }, 429);
  }

  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, msg: "JSON 解析失败" }, 400); }

  const prompt = clamp(body.prompt, MAX_PROMPT).trim();
  if (!prompt) return json({ ok: false, msg: "需求描述不能为空" }, 400);
  const lang = clamp(body.lang, 20);
  const mode = clamp(body.mode, 10) || "generate";

  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) return json({ ok: false, msg: "AI 服务未配置，请联系管理员" }, 503);

  let userMsg;
  if (mode === "explain") {
    userMsg = "请解释下面这段代码的作用，逐段讲清楚" + (lang ? "（语言：" + lang + "）" : "") + "：\n\n" + prompt;
  } else if (mode === "fix") {
    userMsg = "下面这段代码有 bug 或运行报错，请找出问题并给出修复后的完整代码" + (lang ? "（语言：" + lang + "）" : "") + "：\n\n" + prompt;
  } else {
    userMsg = "请用" + (lang || "合适的") + "语言实现以下需求：\n\n" + prompt;
  }

  /* 多轮上下文：最多带最近 8 条历史，每条裁剪到 4000 字 */
  const history = Array.isArray(body.history)
    ? body.history.slice(-8).map(m => ({
        role: m && m.role === "assistant" ? "assistant" : "user",
        content: clamp(m && m.content, 4000),
      })).filter(m => m.content.trim())
    : [];
  if (history.length > 12) history.length = 12;

  const messages = [{ role: "system", content: SYSTEM }].concat(history, [{ role: "user", content: userMsg }]);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);   // 代码生成比审核慢，放宽到 55 秒
  try {
    const r = await fetch(GLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: messages,
        temperature: 0.3,
        max_tokens: MAX_OUTPUT,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("GLM HTTP " + r.status);
    const data = await r.json();
    const text = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content || "";
    if (!text.trim()) throw new Error("GLM 返回为空");
    return json({ ok: true, text: text.slice(0, 8000) });
  } catch (e) {
    return json({ ok: false, msg: "AI 生成失败：" + clamp(e.message, 100) }, 502);
  } finally {
    clearTimeout(timer);
  }
};
