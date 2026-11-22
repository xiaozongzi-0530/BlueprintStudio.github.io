/* /api/quota —— 付费模型 token 额度管理
   ------------------------------------------------------------
   管理员：分发/查询用户 token 额度；用户：查自己额度。
   - self   {}                          登录用户查自己额度
   - list   {}                          管理员列出所有用户额度
   - grant  {email, quota, mode}        管理员分发额度
              mode: set(设为)/add(增加)/deduct(扣减)
   - logs   {}                          管理员查最近扣减流水
   额度存在 users 库用户记录的 tokenQuota/tokenUsed 字段。
*/
import {
  json, preflight, clientIP, rateLimit, verifyToken, ADMIN_EMAIL,
  getUsersRaw, putUsersRaw, stripUsers, getStore, getQuota,
} from "./_lib.js";

export const config = { path: "/api/quota" };

function bad(msg, status) { return json({ ok: false, msg: msg || "请求不合法" }, status || 400); }

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return bad("只支持 POST", 405);

  const ip = clientIP(req);
  if (!rateLimit("quota", ip, 40, 60 * 1000)) return bad("操作太频繁，请一分钟后再试", 429);

  const tok = await verifyToken(req);
  if (!tok) return bad("请先登录", 401);

  let body;
  try { body = await req.json(); } catch (e) { return bad("JSON 解析失败"); }
  const act = body.action;
  const isAdmin = tok.email === ADMIN_EMAIL;

  const db = await getUsersRaw();
  const users = db.users = db.users || {};

  /* 用户查自己额度 */
  if (act === "self") {
    const rec = users[tok.email];
    const q = getQuota(rec);
    return json({ ok: true, quota: q.quota, used: q.used, left: Math.max(0, q.quota - q.used) });
  }

  /* 以下仅管理员 */
  if (!isAdmin) return bad("仅管理员可执行", 403);

  if (act === "list") {
    const out = [];
    Object.keys(users).forEach(email => {
      const q = getQuota(users[email]);
      out.push({ email: email, quota: q.quota, used: q.used, left: Math.max(0, q.quota - q.used),
        banned: !!users[email].banned });
    });
    out.sort((a, b) => (b.quota - a.quota) || a.email.localeCompare(b.email));
    return json({ ok: true, users: out });
  }

  if (act === "grant") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || !users[email]) return bad("账号不存在", 404);
    const raw = Number(body.quota);
    if (!isFinite(raw) || raw < 0) return bad("额度不合法");
    const n = Math.floor(raw);
    const mode = ["set", "add", "deduct"].indexOf(body.mode) === -1 ? "set" : body.mode;
    const cur = getQuota(users[email]).quota;
    let next = n;
    if (mode === "add") next = cur + n;
    if (mode === "deduct") next = Math.max(0, cur - n);
    users[email].tokenQuota = next;
    await putUsersRaw(db);
    return json({ ok: true, email: email, quota: next });
  }

  if (act === "logs") {
    const meta = getStore("meta");
    let logs = [];
    try { logs = JSON.parse((await meta.get("__quota_logs")) || "[]"); } catch (e) {}
    return json({ ok: true, logs: logs.slice(-30).reverse() });
  }

  return bad("未知操作");
};
