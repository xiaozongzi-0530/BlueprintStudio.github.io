/* BlueprintStudio 数据服务 · 共享库（以 _ 开头的文件不会被部署为函数）
   ------------------------------------------------------------
   安全模型：
   - API 签名密钥首次运行时自动生成，存 Blobs meta 库，永不出现在代码/环境变量里
   - 登录签发 HMAC token（有效期 7 天），写操作需携带
   - users 库（含密码 hash）只能通过 /api/auth 读写，通用数据接口禁止触碰，
     读取用户列表时一律剥离 hash 字段
   - 旧数据源 textdb.dev 公开可写，迁移后原库中的密码 hash 会被脱敏删除 */
import { getStore } from "@netlify/blobs";

export const ADMIN_EMAIL = "zhouxinyuan0530@qq.com";

/* 允许游客（无 token）写入的 key：UGC 区本来就是开放的，靠限流兜底 */
export const GUEST_WRITABLE = new Set([
  "blueprintstudio-forum-2026",
  "blueprintstudio-notes-2026",
  "blueprintstudio-chat-v2",
  "blueprintstudio-discover-v1",
  "blueprintstudio-logs-v1",   /* 前端错误日志匿名上报 */
]);
/* 仅管理员可写的 key */
export const ADMIN_ONLY = new Set([
  "blueprintstudio-users-v2",
  "blueprintstudio-announce-v2",
]);

/* ---------- 工具 ---------- */
export function json(body, status, headers) {
  const h = Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  }, headers || {});
  return new Response(JSON.stringify(body), { status: status || 200, headers: h });
}

export function preflight() {
  return new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  } });
}

export function clientIP(req) {
  const h = req.headers;
  return (h.get("x-nf-client-connection-ip") || h.get("x-forwarded-for") || "0.0.0.0").split(",")[0].trim();
}

/* ---------- 内存限流（函数实例间不共享，够挡住单实例内的刷量） ---------- */
const buckets = new Map();
export function rateLimit(name, ip, limit, windowMs) {
  const now = Date.now();
  const key = name + "|" + ip;
  let b = buckets.get(key);
  if (!b || now > b.until) { b = { n: 0, until: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 5000) buckets.clear();   // 防内存膨胀
  return b.n <= limit;
}

/* ---------- API 签名密钥：首访自动生成，存服务端 ---------- */
let _secret = null;
export async function getSecret() {
  if (_secret) return _secret;
  const meta = getStore("meta");
  let s = await meta.get("__api_secret");
  if (!s) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    s = Array.from(buf).map(x => x.toString(16).padStart(2, "0")).join("");
    await meta.set("__api_secret", s);
  }
  _secret = s;
  return s;
}

function b64url(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64url(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return decodeURIComponent(escape(atob(s))); }

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig)).map(x => x.toString(16).padStart(2, "0")).join("");
}
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------- token：base64url(payload).hmac ---------- */
export async function signToken(payload) {
  const secret = await getSecret();
  const body = b64url(JSON.stringify(payload));
  return body + "." + (await hmacHex(secret, body));
}

export async function verifyToken(req) {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const dot = m[1].lastIndexOf(".");
  if (dot < 1) return null;
  const body = m[1].slice(0, dot), sig = m[1].slice(dot + 1);
  const secret = await getSecret();
  if (!safeEq(sig, await hmacHex(secret, body))) return null;
  try {
    const obj = JSON.parse(unb64url(body));
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch (e) { return null; }
}

/* ---------- users 库操作 ---------- */
const usersStore = () => getStore("users");

/* 读取 users（服务端内部用，含 hash），结构兼容旧 textdb：{users:{email:{...}}} */
export async function getUsersRaw() {
  const s = await usersStore().get("__all");
  if (!s) return { users: {} };
  try { return JSON.parse(s); } catch (e) { return { users: {} }; }
}
export async function putUsersRaw(db) {
  await usersStore().set("__all", JSON.stringify(db));
}

/* 对外输出：剥离 hash，绝不让密码离开服务端 */
export function stripUsers(db) {
  const out = { users: {} };
  const src = (db && db.users) || {};
  Object.keys(src).forEach(email => {
    const u = Object.assign({}, src[email]);
    delete u.hash;
    out.users[email] = u;
  });
  return out;
}

/* 登录成功签发 7 天 token */
export async function issueToken(email, rec) {
  return signToken({
    email: email,
    uid: rec.uid || "",
    admin: email === ADMIN_EMAIL,
    exp: Date.now() + 7 * 24 * 3600 * 1000,
  });
}
