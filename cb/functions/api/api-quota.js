/* /api/quota —— 付费模型 token 额度管理
   ------------------------------------------------------------
   管理员：分发/查询用户 token 额度；用户：查自己额度。
   - self   {}                          登录用户查自己额度
   - list   {}                          管理员列出所有用户额度
   - grant  {email, quota, mode}        管理员分发额度（直接加，无需兑换）
              mode: set(设为)/add(增加)/deduct(扣减)
   - issue  {email, quota}              管理员生成兑换码并通过邮件发送（45秒有效）
   - codes  {}                          管理员查最近生成的兑换码
   - redeem {code}                      登录用户兑换码 → 加到自己额度
   - logs   {}                          管理员查最近扣减流水
   额度存在 users 库用户记录的 tokenQuota/tokenUsed 字段。
*/
import {
  json, preflight, clientIP, rateLimit, verifyToken, ADMIN_EMAIL,
  getUsersRaw, putUsersRaw, stripUsers, getStore, getQuota,
} from "./_lib.js";
import { sendMail, mailConfigured } from "./_mailer.js";
import crypto from "node:crypto";

/* 兑换码有效期：默认 45 秒，管理员生成时可按秒自定义（30~86400） */
const CODE_TTL = 45 * 1000;
const CODE_TTL_MIN = 30, CODE_TTL_MAX = 86400;
const CODE_KEY = "__token_codes";

/* 有效期秒数 → 人类可读文案 */
function ttlLabel(sec) {
  sec = Number(sec) || 45;
  if (sec < 60) return sec + " 秒";
  if (sec < 3600) return (Math.round(sec / 60 * 10) / 10) + " 分钟";
  return (Math.round(sec / 3600 * 10) / 10) + " 小时";
}

/* 生成兑换码：8 位大写字母数字，去掉易混淆字符 */
function newCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < b.length; i++) s += abc[b[i] % abc.length];
  return s;
}

/* 读取/写入兑换码列表 */
async function loadCodes() {
  const meta = getStore("meta");
  try { const a = JSON.parse((await meta.get(CODE_KEY)) || "[]"); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
async function saveCodes(list) {
  const meta = getStore("meta");
  await meta.set(CODE_KEY, JSON.stringify(list.slice(-100)));
}

/* 兑换码邮件正文（深蓝科技风，与站点一致） */
function codeMailHtml(code, tokens, email, ttlSec) {
  var ttlText = ttlLabel(ttlSec);
  return '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;background:#0a1128;color:#e6ebf5;padding:28px 18px;border-radius:14px">' +
    '<div style="max-width:480px;margin:0 auto">' +
    '<div style="font-size:20px;font-weight:700;color:#22d3ee;margin-bottom:18px">BlueprintStudio</div>' +
    '<h2 style="font-size:20px;margin:0 0 12px">你的 Token 兑换码</h2>' +
    '<p style="color:#8a93a8;font-size:14px;line-height:1.8;margin:0 0 18px">' +
    '管理员已为你生成 <b style="color:#22d3ee">' + tokens.toLocaleString() + ' token</b> 额度，请在有效期内登录 AI 工作台兑换。</p>' +
    '<div style="background:rgba(34,211,238,.08);border:1px solid rgba(34,211,238,.35);border-radius:12px;padding:20px;text-align:center;margin:18px 0">' +
    '<div style="font-size:28px;font-weight:800;letter-spacing:6px;color:#22d3ee">' + code + '</div></div>' +
    '<p style="color:#ff6b6b;font-size:13px;margin:0 0 8px">⏱ 有效期仅 ' + ttlText + '，过期失效。若已过期请联系管理员重新生成。</p>' +
    '<p style="color:#8a93a8;font-size:12px;margin-top:20px">收件人：' + String(email).replace(/[<>&]/g, "") + '<br>此邮件由系统自动发送，请勿直接回复。</p>' +
    '</div></div>';
}

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

  /* 登录用户兑换码 → 加到自己额度 */
  if (act === "redeem") {
    const code = String(body.code || "").trim().toUpperCase();
    if (!code) return bad("请输入兑换码");
    const codes = await loadCodes();
    const idx = codes.findIndex(c => c.code === code);
    if (idx === -1) return bad("兑换码无效，请检查后重试");
    const item = codes[idx];
    if (item.used) return bad("该兑换码已被使用");
    if (Date.now() > Number(item.expireAt)) return bad("兑换码已过期（有效期 " + ttlLabel(item.ttl) + "），请联系管理员重新生成");
    /* 校验通过：标记已用 + 给用户加额度（add 到 tokenQuota） */
    codes[idx].used = true;
    codes[idx].usedBy = tok.email;
    codes[idx].usedAt = Date.now();
    const rec = users[tok.email];
    if (!rec) return bad("账号不存在", 404);
    const cur = getQuota(rec).quota;
    const addTokens = Math.max(1, Math.floor(Number(item.tokens) || 0));
    rec.tokenQuota = cur + addTokens;
    await saveCodes(codes);
    await putUsersRaw(db);
    /* 记一条流水 */
    try {
      const meta = getStore("meta");
      const logs = JSON.parse((await meta.get("__quota_logs")) || "[]");
      logs.push({ t: Date.now(), email: tok.email, model: "兑换码", tokens: addTokens, mult: 1, cost: addTokens, left: Math.max(0, rec.tokenQuota - (Number(rec.tokenUsed) || 0)) });
      if (logs.length > 200) logs.splice(0, logs.length - 200);
      await meta.set("__quota_logs", JSON.stringify(logs));
    } catch (e) {}
    return json({ ok: true, tokens: addTokens, quota: rec.tokenQuota,
      left: Math.max(0, rec.tokenQuota - (Number(rec.tokenUsed) || 0)) });
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
    const mode = ["set", "add", "deduct", "reset"].indexOf(body.mode) === -1 ? "set" : body.mode;
    const cur = getQuota(users[email]).quota;
    let next = n;
    if (mode === "add") next = cur + n;
    if (mode === "deduct") next = Math.max(0, cur - n);
    if (mode === "reset") {           // 重置：设为指定额度并清零已用（修复被打穿的账号）
      users[email].tokenQuota = n;
      users[email].tokenUsed = 0;
      await putUsersRaw(db);
      return json({ ok: true, email: email, quota: n, used: 0, left: n });
    }
    users[email].tokenQuota = next;
    await putUsersRaw(db);
    return json({ ok: true, email: email, quota: next });
  }

  /* 管理员生成兑换码 → 邮件发给指定邮箱（45秒有效） */
  if (act === "issue") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email) || email.length > 120) return bad("邮箱格式不正确");
    const raw = Number(body.quota);
    if (!isFinite(raw) || raw < 1) return bad("token 数量不合法");
    const tokens = Math.floor(raw);
    /* 自定义有效期（秒），默认 45；越界则 clamp */
    let ttlSec = Number(body.ttl);
    if (!isFinite(ttlSec) || ttlSec < CODE_TTL_MIN) ttlSec = 45;
    ttlSec = Math.min(CODE_TTL_MAX, Math.floor(ttlSec));

    const code = newCode();
    const item = { code: code, tokens: tokens, email: email, ttl: ttlSec,
      createdAt: Date.now(), expireAt: Date.now() + ttlSec * 1000, used: false };
    const codes = await loadCodes();
    codes.push(item);
    await saveCodes(codes);

    /* 尝试发邮件：失败不阻塞，兑换码仍返回给管理员可手动转发 */
    let mailOk = false, mailMsg = "";
    if (mailConfigured()) {
      try {
        await sendMail(email,
          "BlueprintStudio · 你的 Token 兑换码（" + ttlLabel(ttlSec) + "内有效）",
          "你的兑换码是 " + code + "，对应 " + tokens + " token，" + ttlLabel(ttlSec) + "内有效。登录 AI 工作台输入兑换。",
          codeMailHtml(code, tokens, email, ttlSec));
        mailOk = true;
      } catch (e) { mailMsg = String(e && e.message || e).slice(0, 120); }
    } else {
      mailMsg = "服务端未配置 SMTP_USER / SMTP_PASS，未能发送邮件";
    }

    return json({ ok: true, code: code, tokens: tokens, email: email, ttl: ttlSec,
      expireIn: ttlSec, mailSent: mailOk,
      mailError: mailOk ? "" : mailMsg,
      msg: mailOk ? ("兑换码已生成并发送至 " + email) : "兑换码已生成，但邮件未发送成功，请手动转发下方兑换码" });
  }

  /* 管理员查最近生成的兑换码 */
  if (act === "codes") {
    const codes = await loadCodes();
    return json({ ok: true, codes: codes.slice(-30).reverse().map(c => ({
      code: c.code, tokens: c.tokens, email: c.email, ttl: c.ttl || 45,
      createdAt: c.createdAt, expireAt: c.expireAt,
      expired: Date.now() > c.expireAt, used: !!c.used, usedBy: c.usedBy || "",
    })) });
  }

  if (act === "logs") {
    const meta = getStore("meta");
    let logs = [];
    try { logs = JSON.parse((await meta.get("__quota_logs")) || "[]"); } catch (e) {}
    return json({ ok: true, logs: logs.slice(-30).reverse() });
  }

  /* 管理员清空 token 流水记录 */
  if (act === "purgeLogs") {
    const meta = getStore("meta");
    try { await meta.set("__quota_logs", "[]"); } catch (e) {}
    return json({ ok: true, msg: "流水记录已清空" });
  }

  return bad("未知操作");
};
