/* /api/vip —— 会员状态查询 & 激活码兑换（服务端权威）
   ------------------------------------------------------------
   POST JSON {action, ...}
     status  {}              查询当前登录用户的会员状态（需登录）
     redeem  {code}          兑换激活码，成功写入用户记录 vip=true（需登录）
   会员状态存在 users 库的用户记录里（vip / vipUntil 字段），
   前端 localStorage 里的任何标记都不作为判据。
*/
import {
  json, preflight, clientIP, rateLimit, verifyToken,
  getUsersRaw, putUsersRaw, VIP_CODES, isVipUser,
} from "./_lib.js";

export const config = { path: "/api/vip" };

function bad(msg, status) { return json({ ok: false, msg: msg || "请求不合法" }, status || 400); }

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return bad("只支持 POST", 405);

  const ip = clientIP(req);
  if (!rateLimit("vip", ip, 20, 60 * 1000)) return bad("操作太频繁，请一分钟后再试", 429);

  /* 必须登录：会员绑定账号，兑换才有归属 */
  const tok = await verifyToken(req);
  if (!tok) return bad("请先登录后再开通会员", 401);

  let body;
  try { body = await req.json(); } catch (e) { return bad("JSON 解析失败"); }
  const act = body.action;

  const db = await getUsersRaw();
  const users = db.users = db.users || {};
  const rec = users[tok.email];
  if (!rec) return bad("账号不存在，请重新登录", 404);

  /* 查询状态 */
  if (act === "status") {
    const vip = rec.vip === true || (rec.vipUntil && Date.now() < Number(rec.vipUntil));
    return json({ ok: true, vip: !!vip, vipUntil: rec.vipUntil || null, email: tok.email });
  }

  /* 兑换激活码 */
  if (act === "redeem") {
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) return bad("请输入激活码");
    if (VIP_CODES.map(c => String(c).toUpperCase()).indexOf(code) === -1) {
      return bad("激活码无效，请联系管理员");
    }
    if (isVipUser(rec)) {
      return json({ ok: true, vip: true, msg: "你的账号已是会员" });
    }
    rec.vip = true;
    await putUsersRaw(db);
    return json({ ok: true, vip: true, msg: "会员开通成功" });
  }

  return bad("未知操作");
};
