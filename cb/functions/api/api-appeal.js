/* /api/appeal —— AI 判定违规后的人工申诉
   ------------------------------------------------------------
   POST {kind, content, aiReason, who}          提交申诉（无需登录，游客也可）
   POST {action:"resolve", id, outcome}         管理员处理（outcome: "误判放行" | "维持判定"）
   GET                                          管理员拉取申诉列表

   申诉内容（含被判违规的原文）存在服务端私有 Blobs 库，
   不经过 /api/data 公开通道，普通用户看不到，只有管理员 token 能读。 */
import { getStore, json, preflight, clientIP, rateLimit, verifyToken } from "./_lib.js";

export const config = { path: "/api/appeal" };

const MAX_ITEMS = 200;   // 申诉留最近 200 条，超出丢最旧的

const store = () => getStore("appeals");

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

  /* ---------- 管理员处理 ---------- */
  if (body.action === "resolve") {
    const tok = await verifyToken(req);
    if (!tok || !tok.admin) return json({ ok: false, msg: "需要管理员身份" }, 403);
    const items = await readAll();
    const it = items.find(i => i.id === body.id);
    if (!it) return json({ ok: false, msg: "申诉不存在" }, 404);
    it.status = "done";
    it.outcome = clamp(body.outcome || "已处理", 40);
    it.handledBy = tok.email;
    it.handledAt = new Date().toISOString();
    await writeAll(items);
    return json({ ok: true });
  }

  /* ---------- 用户提交申诉 ---------- */
  /* 提交限流：同一 IP 每小时 5 条，防刷申诉库 */
  if (!rateLimit("appeal", ip, 5, 3600 * 1000)) {
    return json({ ok: false, msg: "申诉提交太频繁，请一小时后再试" }, 429);
  }

  const kind = clamp(body.kind, 20);
  const content = clamp(body.content, 6000);
  const aiReason = clamp(body.aiReason, 200);
  if (!content.trim()) return json({ ok: false, msg: "申诉内容为空" }, 400);

  const items = await readAll();
  items.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    kind: kind || "unknown",
    content: content,
    aiReason: aiReason,
    who: clamp(body.who, 120),
    ip: ip,
    status: "pending",
    t: new Date().toISOString(),
  });
  await writeAll(items);
  return json({ ok: true, msg: "申诉已提交，管理员将在 3 个工作日内人工处理" });
};
