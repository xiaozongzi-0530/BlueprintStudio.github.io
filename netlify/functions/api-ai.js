/* /api/ai —— AI 工作台统一接口（生图 / 生视频 / 生成文件 / 下载）
   ------------------------------------------------------------
   POST {action:"generate", kind:"image"|"video"|"file", prompt, ...}
     image  → CogView 同步生图，拿到 URL 后立即转存，返回 ready
     video  → CogVideoX 异步任务，先返回 asset id（status=pending），前端轮询
     file   → GLM 生成文本，存成 .md 文件，返回 ready
   所有生成需登录 token；资产按 uid 隔离。

   GET ?action=status&id=xxx      查单个资产状态（会推进视频转存）
   GET ?action=list               列出我的资产（3 天内）
   GET ?action=download&id=xxx    下载文件（二进制，需登录且归属本人）
   GET ?action=thumb&id=xxx       图片/视频缩略预览（同 download，内联Content-Type）

   环境变量：GLM_API_KEY（智谱开放平台，与 GLM 对话共用同一把 key）
*/
import { json, preflight, clientIP, rateLimit, verifyToken } from "./_lib.js";
import { GLM_URL } from "./_glm.js";
import {
  ASSET_TTL, newAssetId, putAsset, getAsset, delAsset, listAssets,
  stashRemote, readFile,
} from "./_aistore.js";

export const config = { path: "/api/ai" };

const IMAGE_MODEL = "cogview-3-flash";   // 免费生图
const VIDEO_MODEL = "cogvideox-flash";   // 免费生视频
const TEXT_MODEL = "glm-4-flash";        // 文本生成（文件）
const ASYNC_RESULT = "https://open.bigmodel.cn/api/paas/v4/async-result/";
const PROMPT_MAX = 1200;

function clamp(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : Math.max(min, Math.min(max, n));
}

async function glmFetch(apiKey, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 40000);
  try {
    const r = await fetch(GLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) {
      const msg = data && data.error ? (data.error.message || data.error.code) : ("HTTP " + r.status);
      throw new Error("GLM " + clamp(msg, 100));
    }
    return data;
  } finally { clearTimeout(timer); }
}

/* 判断 GLM 400 是否为地域/模型不支持，给出友好提示 */
function friendly(e) {
  const m = String(e && e.message || e);
  if (m.indexOf("400") !== -1) return "当前部署节点不支持该生成模型（地域限制），请稍后重试或联系管理员切换节点";
  return "生成失败：" + clamp(m, 100);
}

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  const url = new URL(req.url);
  const action = (req.method === "GET" ? url.searchParams.get("action") : (await safeBody(req)).action) || "";

  /* ---------- GET：状态 / 列表 / 下载 ---------- */
  if (req.method === "GET") {
    const tok = await verifyToken(req);
    if (!tok) return json({ ok: false, msg: "请先登录" }, 401);
    const uid = tok.uid || tok.email;

    if (action === "list") {
      return json({ ok: true, items: await listAssets(uid, 60), now: Date.now() });
    }

    if (action === "status") {
      const id = url.searchParams.get("id") || "";
      const a = await getAsset(id);
      if (!a || a.uid !== uid) return json({ ok: false, msg: "资产不存在" }, 404);
      if (a.status === "ready" || a.status === "failed") return json({ ok: true, asset: publicAsset(a) });
      /* pending：推进视频任务 */
      const apiKey = process.env.GLM_API_KEY;
      if (!apiKey) return json({ ok: true, asset: publicAsset(a) });
      try {
        const r = await fetch(ASYNC_RESULT + encodeURIComponent(a.taskId), {
          headers: { "Authorization": "Bearer " + apiKey },
        });
        const d = await r.json();
        const st = d && d.task_status;
        if (st === "SUCCESS") {
          const vurl = d.video_result && d.video_result[0] && d.video_result[0].url;
          if (!vurl) { a.status = "failed"; a.err = "无视频结果"; await putAsset(a); }
          else {
            try { await stashRemote(a, vurl, 50000); }
            catch (se) {
              /* 转存失败：退而求其次，24 小时内用远程 URL 重定向下载 */
              a.remoteUrl = vurl; a.status = "remote"; a.err = clamp(String(se.message || se), 80);
              a.remoteUntil = Date.now() + 24 * 3600 * 1000;
              await putAsset(a);
            }
          }
        } else if (st === "FAIL") {
          a.status = "failed"; a.err = "生成失败"; await putAsset(a);
        }
        /* PROCESSING：保持 pending，前端继续轮询 */
      } catch (e) { /* 查询抖动：保持 pending */ }
      return json({ ok: true, asset: publicAsset(a) });
    }

    if (action === "download" || action === "thumb") {
      const id = url.searchParams.get("id") || "";
      const a = await getAsset(id);
      if (!a || a.uid !== uid) return json({ ok: false, msg: "资产不存在" }, 404);
      if (Date.now() - (a.createdAt || 0) > ASSET_TTL) {
        await delAsset(id);
        return json({ ok: false, msg: "文件已过期（仅保留 3 天）" }, 410);
      }
      /* 远程兜底：临时重定向到智谱 URL */
      if (a.status === "remote" && a.remoteUrl && Date.now() < (a.remoteUntil || 0)) {
        return new Response(null, { status: 302, headers: { Location: a.remoteUrl, "Cache-Control": "no-store" } });
      }
      const f = await readFile(a);
      if (!f) return json({ ok: false, msg: "文件尚未就绪或已清理" }, 404);
      const inline = action === "thumb";
      const disp = (inline ? "inline" : "attachment") + '; filename="' + f.name.replace(/["\r\n]/g, "") + '"';
      return new Response(f.body, {
        status: 200,
        headers: {
          "Content-Type": f.contentType,
          "Content-Disposition": disp,
          "Content-Length": String(f.body.byteLength),
          "Cache-Control": "private, no-store",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return json({ ok: false, msg: "未知操作" }, 400);
  }

  /* ---------- POST：生成 ---------- */
  if (req.method !== "POST") return json({ ok: false, msg: "只支持 GET/POST" }, 405);
  const tok = await verifyToken(req);
  if (!tok) return json({ ok: false, msg: "请先登录后再使用 AI 生成" }, 401);
  const uid = tok.uid || tok.email;

  const ip = clientIP(req);
  if (!rateLimit("aigen", ip, 12, 60 * 1000)) return json({ ok: false, msg: "生成太频繁，请一分钟后再试" }, 429);

  const body = await safeBody(req);
  if (body.action && body.action !== "generate") return json({ ok: false, msg: "未知操作" }, 400);
  const kind = ["image", "video", "file"].indexOf(body.kind) !== -1 ? body.kind : "";
  if (!kind) return json({ ok: false, msg: "生成类型不合法" }, 400);
  const prompt = clamp(body.prompt, PROMPT_MAX).trim();
  if (!prompt) return json({ ok: false, msg: "描述不能为空" }, 400);

  const apiKey = process.env.GLM_API_KEY;
  if (!apiKey) return json({ ok: false, msg: "AI 生成服务未配置，请联系管理员" }, 503);

  const asset = {
    id: newAssetId(),
    uid: uid,
    email: tok.email || "",
    type: kind,
    prompt: prompt,
    status: "pending",
    stored: false,
    createdAt: Date.now(),
  };

  try {
    if (kind === "image") {
      const size = ["1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"].indexOf(body.size) !== -1
        ? body.size : "1024x1024";
      asset.size = size;
      const d = await glmFetch(apiKey, { model: IMAGE_MODEL, prompt, size, user_id: clamp(uid, 6, 128) }, 40000);
      const url = d && d.data && d.data[0] && d.data[0].url;
      if (!url) throw new Error("未返回图片");
      await stashRemote(asset, url, 50000);   // 同步转存 → ready
      await putAsset(asset);
      return json({ ok: true, asset: publicAsset(asset) });
    }

    if (kind === "video") {
      /* 图生视频：若前端传了 imageUrl（本系统生成的图片远程 URL 不可直接外链，
         这里仅接受公开可访问的图片 URL；一般走纯文生视频） */
      const reqBody = { model: VIDEO_MODEL, prompt };
      if (body.imageUrl && /^https?:\/\//.test(body.imageUrl)) reqBody.image_url = clamp(body.imageUrl, 500);
      const d = await glmFetch(apiKey, reqBody, 30000);
      const taskId = d && d.id;
      if (!taskId) throw new Error("未返回任务ID");
      asset.taskId = taskId;
      asset.status = "pending";
      await putAsset(asset);
      return json({ ok: true, asset: publicAsset(asset) });
    }

    /* file：用 GLM 生成文本，存成 .md 下载。
       format 决定内容形态：code(代码)/doc(文档)/any(自由) */
    const format = ["code", "doc", "any"].indexOf(body.format) !== -1 ? body.format : "any";
    asset.format = format;
    const ext = format === "code" ? "txt" : "md";
    const sys = format === "code"
      ? "你是编程助手。按用户需求直接产出完整代码，不要多余解释。代码用纯文本输出。"
      : "你是写作助手。按用户需求直接产出完整内容（Markdown 格式），不要寒暄和额外解释。";
    const d = await glmFetch(apiKey, {
      model: TEXT_MODEL,
      messages: [{ role: "system", content: sys }, { role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 4000,
    }, 40000);
    let text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || "";
    text = String(text).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!text) throw new Error("生成内容为空");
    const enc = new TextEncoder().encode(text);
    const { getStore } = await import("@netlify/blobs");
    await getStore("ai-files").set(asset.id, enc, { metadata: { contentType: format === "code" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8" } });
    asset.stored = true;
    asset.status = "ready";
    asset.contentType = format === "code" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8";
    asset.size = enc.byteLength;
    asset.ext = ext;
    await putAsset(asset);
    return json({ ok: true, asset: publicAsset(asset) });
  } catch (e) {
    return json({ ok: false, msg: friendly(e) }, 502);
  }
};

async function safeBody(req) {
  try { return await req.json() || {}; } catch (e) { return {}; }
}

/* 对外暴露的资产字段（不泄露 taskId / 内部错误细节可选） */
function publicAsset(a) {
  return {
    id: a.id, type: a.type, prompt: a.prompt, status: a.status,
    createdAt: a.createdAt, expiresAt: (a.createdAt || 0) + ASSET_TTL,
    size: a.size, contentType: a.contentType, ext: a.ext,
    stored: a.stored, err: a.err || "",
    hasFile: a.status === "ready" || a.status === "remote",
  };
}
