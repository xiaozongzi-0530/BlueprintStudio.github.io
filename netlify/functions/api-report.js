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

    /* 举报成立 → 自动封禁被举报人（仅注册邮箱；游客是本地随机身份，服务端封不了，
       请直接删除其内容；管理员账号永不自动封禁） */
    let bannedTarget = false;
    let banSkip = "";
    const target = String(it.target || "");
    if (it.outcome.indexOf("举报成立") !== -1 && target) {
      if (target === ADMIN_EMAIL) {
        banSkip = "目标为管理员，未封禁";
      } else if (target.indexOf("guest:") === 0) {
        banSkip = "目标为游客身份，无法服务端封禁，请手动删除其内容";
      } else {
        const db = await getUsersRaw();
        const rec = db.users && db.users[target];
        if (rec) {
          rec.banned = true;
          await putUsersRaw(db);
          bannedTarget = true;
        } else {
          banSkip = "目标账号不存在于用户库";
        }
      }
    }
    it.bannedTarget = bannedTarget;
    if (banSkip) it.banSkip = banSkip;
    await writeAll(items);
    return json({ ok: true, bannedTarget: bannedTarget, banSkip: banSkip });
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
  const apiKey = process.env.GLM_API_KEY;
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
    target: clamp(body.target, 120),   // 被举报人的账号标识（邮箱或 guest:uid），举报成立时自动封禁用
    ip: ip,
    ai: ai,
    aiSkipped: aiSkipped,
    status: "pending",
    t: new Date().toISOString(),
  };
  items.push(rec);
  await writeAll(items);
  return json({
    ok: true,
    ai: { violates: ai.violates, category: ai.category, reason: ai.reason },
    aiSkipped: aiSkipped,
    msg: aiSkipped
      ? "举报已提交，管理员将人工复核"
      : (ai.violates ? "举报已提交：AI 初判疑似违规，已转管理员人工复核" : "举报已提交：AI 初判该内容未发现违规，仍会由管理员人工复核"),
  });
};
