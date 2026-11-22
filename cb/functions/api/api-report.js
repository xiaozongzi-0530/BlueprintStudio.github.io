/* /api/report —— 内容举报（AI 初判 + 管理员人工判定）
   ------------------------------------------------------------
   流程：用户举报 → GLM-4-Flash 对被举报内容 AI 初判 → 存服务端私有库
        → 管理员在后台人工复核（举报成立 / 驳回举报）
        → 被举报作者若不服处理结果，走 /api/appeal 人工申诉

   POST {kind, content, reportReason, who}     用户提交举报（无需登录，游客也可）
        返回 {ok, ai:{violates,category,reason}, skipped?}
   POST {action:"resolve", id, outcome}        管理员人工判定
        outcome: "举报成立（建议删除内容）" | "驳回举报"
   GET                                         管理员拉取举报列表

   举报内容（含被举报原文）存在服务端私有 Blobs 库，
   不经过 /api/data 公开通道，普通用户看不到，只有管理员 token 能读。

   环境变量（Netlify Site settings → Environment variables）：
     GLM_API_KEY   智谱开放平台 API Key（https://open.bigmodel.cn）
*/
import { getStore, getUsersRaw, putUsersRaw, json, preflight, clientIP, rateLimit, verifyToken, ADMIN_EMAIL } from "./_lib.js";
import { judge } from "./_glm.js";

export const config = { path: "/api/report" };

const MAX_ITEMS = 500;   // 举报留最近 500 条，超出丢最旧的

/* 公开内容库：举报成立/自动处置时由服务端删除对应条目 */
const DB_URLS = {
  forum: "https://textdb.dev/api/data/blueprintstudio-forum-2026",
  note: "https://textdb.dev/api/data/blueprintstudio-notes-2026",
  discover: "https://textdb.dev/api/data/blueprintstudio-discover-v1",
};
const LIST_KEY = { forum: "posts", note: "notes", discover: "items" };

/* 从公开库删除一条内容。textdb 是整库覆盖写，有并发覆盖风险，
   但 UGC 区写入频率低，且删违规内容优先级更高，可接受。 */
async function deleteContent(kind, id) {
  const url = DB_URLS[kind];
  if (!url || !id) return { ok: false, why: "不支持的类型或缺少条目 ID" };
  let db;
  try {
    const r = await fetch(url + "?t=" + Date.now());
    if (!r.ok) return { ok: false, why: "读取内容库失败 HTTP " + r.status };
    db = await r.json();
  } catch (e) { return { ok: false, why: "读取内容库异常" }; }
  const key = LIST_KEY[kind];
  if (!db || !Array.isArray(db[key])) return { ok: false, why: "内容库结构异常" };
  const before = db[key].length;
  db[key] = db[key].filter(x => x && x.id !== id);
  if (db[key].length === before) return { ok: false, why: "条目不存在或已被删除" };
  try {
    const pr = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(db),
    });
    if (!pr.ok) return { ok: false, why: "写回内容库失败 HTTP " + pr.status };
    return { ok: true };
  } catch (e) { return { ok: false, why: "写回内容库异常" }; }
}

const store = () => getStore("reports");

async function readAll() {
  const s = await store().get("list");
  if (!s) return [];
  try {
    const db = JSON.parse(s);
    return Array.isArray(db.items) ? db.items : [];
  } catch (e) { return []; }
}
async function writeAll(items) {
  await store().set("list", JSON.stringify({ items: items.slice(-MAX_ITEMS) }));
}

/* 封禁用户：优先 Blobs 用户库（/api/auth 体系），
   查不到则回退 textdb users-v2（前端注册/登录实际使用的库，
   banned 标记由各页面登录与巡检逻辑读取生效） */
const TEXTDB_USERS = "https://textdb.dev/api/data/blueprintstudio-users-v2";
async function banUser(target) {
  let udb = await getUsersRaw();
  if (udb.users && udb.users[target]) {
    udb.users[target].banned = true;
    await putUsersRaw(udb);
    return { ok: true, where: "blobs" };
  }
  try {
    const r = await fetch(TEXTDB_USERS + "?t=" + Date.now());
    if (!r.ok) return { ok: false, why: "textdb 用户库读取失败 HTTP " + r.status };
    const db = await r.json();
    if (db && db.users && db.users[target]) {
      db.users[target].banned = true;
      const pr = await fetch(TEXTDB_USERS, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(db),
      });
      if (!pr.ok) return { ok: false, why: "textdb 用户库写回失败 HTTP " + pr.status };
      return { ok: true, where: "textdb" };
    }
    return { ok: false, why: "目标账号不存在于用户库" };
  } catch (e) {
    return { ok: false, why: "textdb 用户库访问异常" };
  }
}

function clamp(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();

  const ip = clientIP(req);

  /* ---------- 管理员读列表 ---------- */
  if (req.method === "GET") {
    const tok = await verifyToken(req);
    if (!tok || !tok.admin) return json({ ok: false, msg: "需要管理员身份" }, 403);
    const items = await readAll();
    items.reverse();   // 新的在前
    return json({ ok: true, items: items, pending: items.filter(i => i.status === "pending").length });
  }

  if (req.method !== "POST") return json({ ok: false, msg: "只支持 GET/POST" }, 405);

  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, msg: "JSON 解析失败" }, 400); }

  /* ---------- 管理员人工判定 ---------- */
  if (body.action === "resolve") {
    const tok = await verifyToken(req);
    if (!tok || !tok.admin) return json({ ok: false, msg: "需要管理员身份" }, 403);
    const items = await readAll();
    const it = items.find(i => i.id === body.id);
    if (!it) return json({ ok: false, msg: "举报不存在" }, 404);
    it.status = "done";
    it.outcome = clamp(body.outcome || "已处理", 40);
    it.handledBy = tok.email;
    it.handledAt = new Date().toISOString();

    /* 举报成立 → 封禁被举报人（若尚未封）+ 删除原内容 */
    const target = String(it.target || "");
    let bannedTarget = !!it.bannedTarget;
    let banSkip = it.banSkip || "";
    if (it.outcome.indexOf("举报成立") !== -1 && target && !bannedTarget) {
      if (target === ADMIN_EMAIL) {
        banSkip = "目标为管理员，未封禁";
      } else if (target.indexOf("guest:") === 0) {
        banSkip = "目标为游客身份，无法服务端封禁";
      } else {
        const ban = await banUser(target);
        if (ban.ok) bannedTarget = true;
        else banSkip = ban.why;
      }
    }
    it.bannedTarget = bannedTarget;
    if (banSkip) it.banSkip = banSkip;

    let deleted = !!it.deleted;
    if (it.outcome.indexOf("举报成立") !== -1 && !deleted) {
      const del = await deleteContent(it.kind, it.targetId);
      deleted = del.ok;
      if (!del.ok) it.deleteSkip = del.why;
    }
    it.deleted = deleted;
    await writeAll(items);
    return json({ ok: true, bannedTarget: bannedTarget, deleted: deleted, banSkip: banSkip });
  }

  /* ---------- 用户提交举报 ---------- */
  /* 提交限流：同一 IP 每小时 10 条，防拿这里刷 GLM 接口 */
  if (!rateLimit("report", ip, 10, 3600 * 1000)) {
    return json({ ok: false, msg: "举报提交太频繁，请一小时后再试" }, 429);
  }

  const content = clamp(body.content, 6000);
  if (!content.trim()) return json({ ok: false, msg: "举报内容为空" }, 400);

  /* GLM 对被举报内容做 AI 初判；未配 Key 或 GLM 挂了时不阻断举报，
     记录 aiSkipped，管理员人工复核时能看到 */
  const apiKey = process.env.GLM_MODERATE_KEY || process.env.GLM_API_KEY;
  let ai = { violates: false, category: "", reason: "" };
  let aiSkipped = false;
  if (apiKey) {
    try {
      ai = await judge(apiKey, "report", content, body.reportReason);
    } catch (e) {
      aiSkipped = true;
      ai.reason = "AI 初判失败：" + clamp(e.message, 100);
    }
  } else {
    aiSkipped = true;
    ai.reason = "审核服务未配置，跳过 AI 初判";
  }

  const items = await readAll();
  const rec = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    kind: clamp(body.kind, 20) || "unknown",
    content: content,
    reportReason: clamp(body.reportReason, 500),
    who: clamp(body.who, 120),
    target: clamp(body.target, 120),     // 被举报人标识（邮箱或 guest:uid）
    targetId: clamp(body.targetId, 80),  // 被举报内容在公开库里的条目 ID，用于自动删帖
    ip: ip,
    ai: ai,
    aiSkipped: aiSkipped,
    status: "pending",
    t: new Date().toISOString(),
  };

  /* AI 初判违规 → 立即自动封禁被举报人 + 删除原帖（仅注册邮箱可封；
     游客/管理员只删内容）。后台仍保留记录供复核，误封可在账号管理解封。 */
  if (!aiSkipped && ai.violates) {
    /* 删原帖：先删内容再封人，删除失败不阻断封禁 */
    const del = await deleteContent(rec.kind, rec.targetId);
    rec.deleted = del.ok;
    if (!del.ok) rec.deleteSkip = del.why;

    if (rec.target && rec.target !== ADMIN_EMAIL && rec.target.indexOf("guest:") !== 0) {
      const ban = await banUser(rec.target);
      if (ban.ok) {
        rec.bannedTarget = true;
        rec.autoBanned = true;
      } else {
        rec.banSkip = ban.why;
      }
    } else if (rec.target) {
      rec.banSkip = rec.target === ADMIN_EMAIL ? "目标为管理员，未封禁" : "目标为游客身份，无法服务端封禁";
    }
  }

  items.push(rec);
  await writeAll(items);
  const parts = [];
  if (aiSkipped) parts.push("举报已提交，管理员将人工复核");
  else if (ai.violates) parts.push("举报已提交：AI 判定违规");
  else parts.push("举报已提交：AI 初判未发现违规，仍由管理员人工复核");
  if (rec.autoBanned) parts.push("被举报人已自动封禁（误封可在账号管理解封）");
  if (rec.deleted) parts.push("原内容已删除");
  if (rec.banSkip) parts.push("⚠ " + rec.banSkip);
  if (rec.deleteSkip) parts.push("⚠ 内容删除失败：" + rec.deleteSkip);
  return json({
    ok: true,
    ai: { violates: ai.violates, category: ai.category, reason: ai.reason },
    aiSkipped: aiSkipped,
    autoBanned: !!rec.autoBanned,
    deleted: !!rec.deleted,
    msg: parts.join("；"),
  });
};
