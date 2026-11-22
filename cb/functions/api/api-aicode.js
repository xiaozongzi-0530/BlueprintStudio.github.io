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
import { GLM_URL } from "./_glm.js";

export const config = { path: "/api/aicode" };

/* 可用模型白名单（均为智谱免费/长期免费档）
   glm-4.7-flash        文字聊天、编程、推理（默认）
   glm-z1-flash         逻辑推理、数学
   glm-4-flash-250414   普通文字聊天（免费档旧型号） */
const MODELS = {
  "glm-4.7-flash": { name: "GLM-4.7-Flash", temp: 0.3 },
  "glm-z1-flash": { name: "GLM-Z1-Flash", temp: 0.6 },
  "glm-4-flash-250414": { name: "GLM-4-Flash", temp: 0.3 },
  "glm-4.1v-thinking-flash": { name: "GLM-4.1V-Thinking-Flash", temp: 0.6 },
  "glm-4.6v-flash": { name: "GLM-4.6V-Flash", temp: 0.6 },
  "glm-4-flash": { name: "GLM-4-Flash（通用）", temp: 0.3 },  /* 海外节点唯一稳定可用的兜底模型 */
};
const DEFAULT_MODEL = "glm-4.7-flash";
const SAFE_MODEL = "glm-4-flash";   /* 地域/兼容兜底：智谱老型号，国内海外都可用 */
const VISION_MODELS = ["glm-4.6v-flash", "glm-4.1v-thinking-flash"];

/* 降级到纯文本模型时，剥掉 messages 里的 image_url，只保留文字 */
function textOnlyMessages(msgs) {
  return msgs.map(function (m) {
    if (Array.isArray(m.content)) {
      var txt = m.content.filter(function (x) { return x && x.type === "text"; })
        .map(function (x) { return x.text; }).join("\n");
      return { role: m.role, content: txt || "（当前为兼容模式，无法读取图片，请文字描述图片内容）" };
    }
    return m;
  });
}

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
  /* 模型路由：不在白名单一律回退默认模型 */
  const modelKey = MODELS[clamp(body.model, 40)] ? clamp(body.model, 40) : DEFAULT_MODEL;
  const mc = MODELS[modelKey];

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

  const messages = [{ role: "system", content: SYSTEM }].concat(history, [buildUserMsg(userMsg, body.attach)]);

  /* ---------- 附件处理 ----------
     attach: [{name, mime, data}]  data：图片=纯 base64（≤1.5MB）；文本=UTF-8 文本（≤40KB）
     带图片时自动改用视觉模型；文本附件直接拼进需求 */
  function buildUserMsg(text, attach) {
    const files = Array.isArray(attach) ? attach.slice(0, 3) : [];
    const imgs = [], txts = [];
    for (const f of files) {
      if (!f || typeof f.data !== "string") continue;
      if (/^image\//.test(String(f.mime)) && f.data.length <= 2 * 1024 * 1024) {
        imgs.push(f);
      } else if (f.data.length <= 40 * 1024) {
        txts.push(f);
      }
    }
    let textOut = text;
    for (const t of txts) {
      textOut += "\n\n【附件文件：" + clamp(t.name, 60) + "】\n```\n" + t.data + "\n```";
    }
    if (imgs.length) {
      const content = imgs.map(im => ({ type: "image_url", image_url: { url: "data:" + clamp(im.mime, 40) + ";base64," + im.data } }));
      content.push({ type: "text", text: textOut });
      return { role: "user", content: content };
    }
    /* 必须返回完整的 {role, content} 消息对象，否则 messages 结构损坏，
       智谱会报 400 Cannot construct instance of com.wd.paas.api.domain.v4.chat */
    return { role: "user", content: textOut };
  }

  /* 带图片附件但选的不是视觉模型 → 自动切 glm-4.1v-thinking-flash（4.6v 当前过载，作备选） */
  const hasImage = Array.isArray(body.attach) && body.attach.some(f => f && /^image\//.test(String(f.mime)) && typeof f.data === "string");
  let effModelKey = modelKey;
  if (hasImage && VISION_MODELS.indexOf(effModelKey) === -1) effModelKey = "glm-4.1v-thinking-flash";
  const effMc = MODELS[effModelKey];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);   // 代码生成比审核慢，放宽到 55 秒

  /* 单次调用；模型过载（429/1305）时抛出可识别错误 */
  async function callOnce(modelKey, temp, textOnly) {
    const r = await fetch(GLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: modelKey,
        messages: textOnly ? textOnlyMessages(messages) : messages,
        temperature: temp,
        max_tokens: modelKey === "glm-z1-flash" ? 6000 : MAX_OUTPUT,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      let detail = "HTTP " + r.status;
      try {
        const errBody = await r.json();
        if (errBody && errBody.error) detail += " code=" + errBody.error.code + " " + clamp(errBody.error.message, 80);
      } catch (e) {}
      throw new Error("GLM " + detail);
    }
    const data = await r.json();
    const msg = data && data.choices && data.choices[0] && data.choices[0].message || {};
    /* 不展示思考过程：剥掉 <think>...</think>（z1 系列把思考嵌在正文里），只留正文 */
    return (msg.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  }

  try {
    let text, usedModel = effModelKey, fellBack = false, geoFallback = false;

    /* 候选降级链：
       1) 主模型（用户所选 / 图片自动切视觉模型）
       2) 同类备用（过载时：视觉↔视觉，纯文本→4-flash-250414）
       3) SAFE_MODEL=glm-4-flash（400/地域限制兜底，剥图片走纯文本） */
    const sameKindFb = hasImage
      ? (effModelKey === "glm-4.6v-flash" ? "glm-4.1v-thinking-flash" : "glm-4.6v-flash")
      : "glm-4-flash-250414";

    let lastErr = null;
    /* 第一跳：主模型 */
    try {
      text = await callOnce(effModelKey, effMc.temp);
    } catch (e) {
      lastErr = e;
      const over = e.message.indexOf("429") !== -1 || e.message.indexOf("1305") !== -1;
      const bad400 = e.message.indexOf("400") !== -1;
      /* 400 多为海外节点对新模型的地域限制 → 直接跳到 SAFE_MODEL */
      if (bad400) {
        text = await callOnce(SAFE_MODEL, MODELS[SAFE_MODEL].temp, true);
        usedModel = SAFE_MODEL; fellBack = true; geoFallback = true;
      } else if (over && sameKindFb !== effModelKey) {
        /* 过载 → 先试同类备用 */
        try {
          text = await callOnce(sameKindFb, MODELS[sameKindFb].temp);
          usedModel = sameKindFb; fellBack = true;
        } catch (e2) {
          /* 同类备用也失败 → SAFE_MODEL 兜底 */
          text = await callOnce(SAFE_MODEL, MODELS[SAFE_MODEL].temp, true);
          usedModel = SAFE_MODEL; fellBack = true; geoFallback = true;
        }
      } else {
        throw e;
      }
    }
    if (!text.trim()) throw new Error("GLM 返回为空");
    return json({ ok: true, text: text.slice(0, 8000), model: MODELS[usedModel].name,
      fallback: fellBack, geoFallback: geoFallback });
  } catch (e) {
    const over = e.message.indexOf("1305") !== -1 || e.message.indexOf("429") !== -1;
    return json({ ok: false, msg: over ? "所选模型当前访问量过大，请稍后再试或换个模型" : "AI 生成失败：" + clamp(e.message, 100) }, 502);
  } finally {
    clearTimeout(timer);
  }
};
