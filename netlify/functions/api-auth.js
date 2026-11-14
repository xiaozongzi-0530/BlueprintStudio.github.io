/* /api/auth —— 账号服务（登录/注册/用户列表/字段级保存）
   POST JSON {action, ...}
   - login    {email, hash}           密码为前端 PBKDF2 结果（与旧 textdb 库兼容）
   - register {email, hash, rec}      rec 为新账号完整记录（nick 为前端加密密文）
   - list     {}                      用户列表（剥离 hash），公开读（与旧 textdb 公开程度一致）
   - saveUsers{users}                 字段级合并保存：
                                       · 以服务端版本为基准，只应用 nick/title/uid/banned/whips 字段
                                       · hash 永远以服务端为准（前端拿不到也改不了）
                                       · 普通用户只能改自己；管理员可改任何人、可新建/删除账号
   所有出参的 user 记录一律剥离 hash。 */
import {
  json, preflight, clientIP, rateLimit, verifyToken,
  getUsersRaw, putUsersRaw, stripUsers, issueToken, ADMIN_EMAIL,
} from "./_lib.js";

export const config = { path: "/api/auth" };

function bad(msg, status) { return json({ ok: false, msg: msg || "请求不合法" }, status || 400); }
function stripUser(rec) {
  const c = Object.assign({}, rec || {});
  delete c.hash;
  return c;
}

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return bad("只支持 POST", 405);

  const ip = clientIP(req);
  if (!rateLimit("auth", ip, 60, 60 * 1000)) return bad("操作太频繁，请一分钟后再试", 429);

  let body;
  try { body = await req.json(); } catch (e) { return bad("JSON 解析失败"); }
  const act = body.action;
  const db = await getUsersRaw();
  const users = db.users = db.users || {};

  if (act === "login") {
    const { email, hash } = body;
    if (!email || !hash) return bad("缺少邮箱或密码");
    const rec = users[email];
    if (!rec) return json({ ok: false, msg: "该邮箱尚未注册" });
    if (rec.banned) return json({ ok: false, msg: "该账号已被封禁", banned: true });
    if (!rec.hash || rec.hash !== hash) return json({ ok: false, msg: "密码不正确" });
    return json({ ok: true, token: await issueToken(email, rec), user: stripUser(rec) });
  }

  if (act === "register") {
    const { email, hash, rec } = body;
    if (!email || !hash || !rec) return bad("注册信息不完整");
    if (users[email]) return json({ ok: false, msg: "该邮箱已注册，请直接登录" });
    if (!rateLimit("reg", ip, 10, 3600 * 1000)) return bad("该 IP 本小时注册次数过多", 429);
    users[email] = rec;   // rec 含 hash/uid/nick(密文)/joined
    await putUsersRaw(db);
    return json({ ok: true, token: await issueToken(email, rec), user: stripUser(rec) });
  }

  if (act === "list") {
    return json({ ok: true, db: stripUsers(db) });
  }

  /* ---- 以下操作需要登录 ---- */
  const tok = await verifyToken(req);
  if (!tok) return bad("请先登录", 401);

  if (act === "whoami") {
    /* 轻量身份探测：logs.html 等页面用它确认 token 是否有效、是否管理员 */
    const rec = users[tok.email];
    return json({ ok: true, email: tok.email, admin: tok.email === ADMIN_EMAIL, banned: !!(rec && rec.banned) });
  }

  if (act === "saveUsers") {
    const incoming = body.users;
    if (!incoming || typeof incoming !== "object") return bad("缺少 users");

    /* 新建（管理员分发账号）：incoming 里有、服务端没有的 */
    const created = [];
    if (tok.admin) {
      Object.keys(incoming).forEach(email => {
        if (!users[email] && incoming[email]) {
          const r = incoming[email];
          if (!r.hash) return;   // 无密码的记录不允许经此通道创建
          users[email] = r;
          created.push(email);
        }
      });
    }

    /* 字段合并：只认白名单字段，hash 永远保留服务端版本 */
    const FIELDS = ["nick", "title", "uid", "banned", "whips", "gs", "guest"];
    Object.keys(incoming).forEach(email => {
      const cur = users[email];
      if (!cur) return;   // 非管理员新建已被上面处理，这里跳过
      if (email !== tok.email && !tok.admin) return;   // 只能改自己
      const inc = incoming[email] || {};
      FIELDS.forEach(f => {
        if (f in inc) cur[f] = inc[f];
      });
    });

    /* 显式删除（仅管理员）：不做隐式删除，防止一次失败的读取导致误删全库 */
    /* 见下方 adminDel */

    await putUsersRaw(db);
    return json({ ok: true, created: created.length });
  }

  if (act === "adminDel") {
    if (tok.email !== ADMIN_EMAIL) return bad("仅管理员可执行", 403);
    if (!body.email || body.email === ADMIN_EMAIL || body.email === tok.email) return bad("目标不合法");
    if (!users[body.email]) return bad("账号不存在", 404);
    delete users[body.email];
    await putUsersRaw(db);
    return json({ ok: true });
  }

  if (act === "deleteSelf") {
    /* 注销自己的账号：需带密码 hash 复核 */
    const rec = users[tok.email];
    if (!rec) return bad("账号不存在", 404);
    if (!body.hash || body.hash !== rec.hash) return bad("密码不正确，注销失败");
    delete users[tok.email];
    await putUsersRaw(db);
    return json({ ok: true });
  }

  return bad("未知操作");
};
