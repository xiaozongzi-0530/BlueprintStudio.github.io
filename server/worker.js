/**
 * BlueprintStudio 邮箱验证码服务 —— Cloudflare Worker
 * ------------------------------------------------------------------
 * 提供两个接口：
 *   POST /send-code    生成 6 位验证码并以 SMTP 发出
 *   POST /verify-code  校验验证码
 *
 * 设计要点：
 *  1. 验证码只存在 KV 里，且只存 HMAC 摘要 —— 即使 KV 数据泄露也拿不到明文。
 *  2. 全部写入路径都有限流，防止有人拿你的邮箱账号刷信（网易会因为发信量异常停用账号）。
 *  3. SMTP 密码只从环境变量读取，永远不会出现在响应里。
 *
 * 环境变量（Settings → Variables and Secrets）：
 *   SMTP_USER   发件邮箱地址
 *   SMTP_PASS   该邮箱的 SMTP 授权码（不是登录密码）
 *   CODE_SECRET 可选，签名密钥；不填则复用 SMTP_PASS
 *
 * KV 绑定（Settings → Bindings）：
 *   CODES -> 任意一个 KV 命名空间
 */

import { connect } from "cloudflare:sockets";

/* ================= 配置 ================= */

const SMTP_HOST = "smtp.yeah.net";
const SMTP_PORT = 465;               // 465 = 隐式 TLS；Cloudflare 禁止 25 端口
const FROM_NAME = "BlueprintStudio";
const SITE_NAME = "BlueprintStudio";

const CODE_TTL = 600;                // 验证码有效期 10 分钟
const MAX_VERIFY_ATTEMPTS = 5;       // 单个验证码最多试 5 次

const ALLOW_ORIGINS = [
  "https://xiaozongzi-0530.github.io",
  "http://127.0.0.1:8899",
  "http://localhost:8899"
];

/* ================= 工具 ================= */

const enc = new TextEncoder();
const dec = new TextDecoder();

function corsHeaders(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors }
  });
}

/** 6 位数字验证码，首位不为 0（避免前端按数字处理时丢位） */
function makeCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  const first = 1 + (a[0] % 9);
  const rest = String(a[0] % 100000).padStart(5, "0");
  return String(first) + rest;
}

async function hmac(keyText, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function isValidEmail(s) {
  if (typeof s !== "string" || s.length > 254) return false;
  return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(s);
}

/* ================= 限流 ================= */

/** 计数型限流：窗口内超过上限即拒绝。返回 true 表示放行。 */
async function allow(kv, key, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  const rec = await kv.get(key, "json");
  if (!rec || now - rec.t > windowSec) {
    await kv.put(key, JSON.stringify({ n: 1, t: now }), { expirationTtl: windowSec + 60 });
    return true;
  }
  if (rec.n >= max) return false;
  rec.n += 1;
  await kv.put(key, JSON.stringify(rec), { expirationTtl: windowSec + 60 });
  return true;
}

/** 冷却型限流：两次动作间隔不足则拒绝。 */
async function cooldown(kv, key, sec) {
  const now = Math.floor(Date.now() / 1000);
  const t = await kv.get(key);
  if (t && now - Number(t) < sec) return { ok: false, wait: sec - (now - Number(t)) };
  await kv.put(key, String(now), { expirationTtl: sec + 30 });
  return { ok: true };
}

/* ================= SMTP ================= */

function openSocket() {
  return connect({ hostname: SMTP_HOST, port: SMTP_PORT }, { secureTransport: "on" });
}

function makeReader(readable) {
  const reader = readable.getReader();
  let buf = "";
  let done = false;
  let tail = "";

  async function readLine() {
    for (;;) {
      const i = buf.indexOf("\r\n");
      if (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        return line;
      }
      if (done) {
        if (buf) { const l = buf; buf = ""; return l; }
        return null;
      }
      const r = await reader.read();
      if (r.done) { done = true; continue; }
      buf += dec.decode(r.value, { stream: true });
    }
  }

  /** 读一条完整 SMTP 响应，自动拼接 250-xxx 这种多行响应 */
  async function readReply() {
    const lines = [];
    for (;;) {
      const line = await readLine();
      if (line === null) throw new Error("SMTP 连接被服务器关闭");
      lines.push(line);
      if (line.length >= 4 && line[3] === "-") continue;
      return { code: Number(line.slice(0, 3)), lines, text: lines.join(" ") };
    }
  }

  return { readReply };
}

function b64utf8(s) {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 编码并按 76 字符折行，符合 RFC 2045 */
function b64wrap(s) {
  return b64utf8(s).replace(/(.{76})/g, "$1\r\n");
}

function dotStuff(s) {
  return s.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
}

function buildMessage({ from, fromName, to, subject, html, text }) {
  const boundary = "bs_" + Math.random().toString(36).slice(2, 12);
  const msgId = "<" + Date.now() + "." + Math.random().toString(36).slice(2, 10) + "@yeah.net>";
  const date = new Date().toUTCString();
  const subj = "=?UTF-8?B?" + b64utf8(subject) + "?=";

  const head = [
    "From: " + (fromName ? "=?UTF-8?B?" + b64utf8(fromName) + "?= " : "") + "<" + from + ">",
    "To: <" + to + ">",
    "Subject: " + subj,
    "Date: " + date,
    "Message-ID: " + msgId,
    "MIME-Version: 1.0",
    "Content-Type: multipart/alternative; boundary=\"" + boundary + "\""
  ].join("\r\n");

  const body = [
    "",
    "--" + boundary,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64wrap(text),
    "--" + boundary,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64wrap(html),
    "--" + boundary + "--",
    ""
  ].join("\r\n");

  return { raw: dotStuff(head + "\r\n\r\n" + body), msgId };
}

/**
 * 走完整的 SMTP 会话把邮件投出去。
 * 失败时抛出带阶段信息的错误，方便定位是认证问题还是投递问题。
 */
async function smtpSend(env, mail) {
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  if (!user || !pass) throw new Error("服务器未配置 SMTP_USER / SMTP_PASS");

  const { raw } = buildMessage(mail);
  const sock = openSocket();
  const { readReply } = makeReader(sock.readable);
  const w = sock.writable.getWriter();

  let stage = "连接";
  const send = async (line) => { await w.write(enc.encode(line + "\r\n")); };
  const expect = async (want, s) => {
    stage = s;
    const r = await readReply();
    const ok = Array.isArray(want) ? want.includes(r.code) : r.code === want;
    if (!ok) throw new Error(stage + "失败(" + r.code + "): " + r.text.slice(0, 160));
    return r;
  };

  try {
    await expect(220, "连接");

    stage = "握手";
    await send("EHLO blueprintstudio");
    const ehlo = await expect(250, "握手");

    stage = "认证";
    if (/AUTH[^\n]*LOGIN/i.test(ehlo.text)) {
      await send("AUTH LOGIN");
      await expect(334, "认证");
      await send(b64utf8(user));
      await expect(334, "认证");
      await send(b64utf8(pass));
      await expect(235, "认证");
    } else {
      await send("AUTH PLAIN " + b64utf8("\u0000" + user + "\u0000" + pass));
      await expect(235, "认证");
    }

    stage = "设置发件人";
    await send("MAIL FROM:<" + user + ">");
    await expect(250, "设置发件人");

    stage = "设置收件人";
    await send("RCPT TO:<" + mail.to + ">");
    await expect([250, 251], "设置收件人");

    stage = "发送正文";
    await send("DATA");
    await expect(354, "发送正文");
    await w.write(enc.encode(raw + "\r\n.\r\n"));
    await expect(250, "发送正文");

    stage = "结束会话";
    try { await send("QUIT"); } catch (_) { /* 服务端可能直接断开，不影响结果 */ }

    return true;
  } finally {
    try { w.releaseLock(); } catch (_) {}
    try { await sock.close(); } catch (_) {}
  }
}

/* ================= 邮件模板 ================= */

function renderMail(code) {
  const subject = "【" + SITE_NAME + "】验证码 " + code;
  const text =
    SITE_NAME + " 邮箱验证\n\n" +
    "你的验证码：" + code + "\n" +
    "有效期 10 分钟，请勿转发给他人。\n\n" +
    "如果不是你本人操作，请忽略这封邮件。\n" +
    "此邮件由系统自动发出，请勿直接回复。";

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(20,30,60,.08);">
  <tr><td style="background:linear-gradient(135deg,#3b6fd4,#5b8def);padding:26px 32px;">
    <div style="color:#ffffff;font-size:19px;font-weight:600;letter-spacing:.5px;">${SITE_NAME}</div>
    <div style="color:rgba(255,255,255,.82);font-size:13px;margin-top:5px;">邮箱验证</div>
  </td></tr>
  <tr><td style="padding:34px 32px 10px;">
    <p style="margin:0 0 20px;color:#2a3550;font-size:15px;line-height:1.7;">你好，你的验证码是：</p>
    <div style="background:#f2f6ff;border:1px solid #dbe6ff;border-radius:10px;padding:20px;text-align:center;">
      <span style="font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#2b5fd0;">${code}</span>
    </div>
    <p style="margin:20px 0 0;color:#6b7688;font-size:13px;line-height:1.8;">
      有效期 <strong style="color:#2a3550;">10 分钟</strong>，请勿转发给他人。<br>
      如果不是你本人操作，请忽略这封邮件。
    </p>
  </td></tr>
  <tr><td style="padding:22px 32px 30px;">
    <div style="border-top:1px solid #edf0f6;padding-top:16px;color:#9aa4b6;font-size:12px;line-height:1.7;">
      此邮件由系统自动发出，请勿直接回复。
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}

/* ================= 主入口 ================= */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    /* 浏览器直接打开时不会带 Origin，这里返回一个状态页，方便部署后自检 */
    if (req.method === "GET" && !origin) {
      return json({
        ok: true,
        service: "BlueprintStudio 邮箱验证码服务",
        status: "running",
        kv: env.CODES ? "已绑定 CODES" : "未绑定 CODES",
        smtp: (env.SMTP_USER && env.SMTP_PASS)
          ? "已配置 SMTP_USER / SMTP_PASS"
          : "未配置 SMTP_USER 或 SMTP_PASS",
        endpoints: ["POST /send-code", "POST /verify-code"]
      }, 200, cors);
    }

    if (!ALLOW_ORIGINS.includes(origin)) {
      return json({ ok: false, error: "forbidden_origin" }, 403, cors);
    }
    if (req.method !== "POST") {
      return json({ ok: false, error: "method_not_allowed" }, 405, cors);
    }
    if (!env.CODES) {
      return json({ ok: false, error: "kv_not_bound", message: "缺少 CODES 这个 KV 绑定" }, 500, cors);
    }

    let body = {};
    try { body = await req.json(); } catch (_) { body = {}; }

    const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";

    /* ---------- 发码 ---------- */
    if (url.pathname === "/send-code") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!isValidEmail(email)) {
        return json({ ok: false, error: "invalid_email", message: "邮箱格式不正确" }, 400, cors);
      }

      // 保护你的网易账号：单 IP 每小时 5 封、全局每天 150 封
      if (!await allow(env.CODES, "ip:" + ip, 5, 3600)) {
        return json({ ok: false, error: "rate_limited", message: "请求过于频繁，请 1 小时后再试" }, 429, cors);
      }
      if (!await allow(env.CODES, "day:" + new Date().toISOString().slice(0, 10), 150, 86400)) {
        return json({ ok: false, error: "quota_exceeded", message: "今日发信额度已用完，请明天再试" }, 429, cors);
      }
      const cdMail = await cooldown(env.CODES, "cd:" + email, 60);
      if (!cdMail.ok) {
        return json({ ok: false, error: "cooldown", message: "请 " + cdMail.wait + " 秒后再获取验证码", wait: cdMail.wait }, 429, cors);
      }

      const code = makeCode();
      const secret = env.CODE_SECRET || env.SMTP_PASS;
      const digest = await hmac(secret, email + "|" + code);

      // 先入库再发信：发信失败时验证码不会被留下
      await env.CODES.put("c:" + email, JSON.stringify({ h: digest, n: 0 }), { expirationTtl: CODE_TTL });

      const mail = renderMail(code);
      try {
        await smtpSend(env, {
          from: env.SMTP_USER, fromName: FROM_NAME, to: email,
          subject: mail.subject, html: mail.html, text: mail.text
        });
      } catch (e) {
        await env.CODES.delete("c:" + email);
        return json({ ok: false, error: "smtp_failed", message: "邮件发送失败：" + String(e.message || e).slice(0, 160) }, 502, cors);
      }

      return json({ ok: true, ttl: CODE_TTL, message: "验证码已发送" }, 200, cors);
    }

    /* ---------- 校验 ---------- */
    if (url.pathname === "/verify-code") {
      const email = String(body.email || "").trim().toLowerCase();
      const code = String(body.code || "").trim();
      if (!isValidEmail(email)) {
        return json({ ok: false, error: "invalid_email", message: "邮箱格式不正确" }, 400, cors);
      }
      if (!/^[1-9]\d{5}$/.test(code)) {
        return json({ ok: false, error: "invalid_code", message: "请输入 6 位数字验证码" }, 400, cors);
      }
      if (!await allow(env.CODES, "vip:" + ip, 20, 3600)) {
        return json({ ok: false, error: "rate_limited", message: "尝试次数过多，请 1 小时后再试" }, 429, cors);
      }

      const rec = await env.CODES.get("c:" + email, "json");
      if (!rec) {
        return json({ ok: false, error: "code_expired", message: "验证码已过期，请重新获取" }, 400, cors);
      }
      if (rec.n >= MAX_VERIFY_ATTEMPTS) {
        await env.CODES.delete("c:" + email);
        return json({ ok: false, error: "too_many_attempts", message: "错误次数过多，验证码已作废，请重新获取" }, 400, cors);
      }

      const secret = env.CODE_SECRET || env.SMTP_PASS;
      const digest = await hmac(secret, email + "|" + code);
      if (digest !== rec.h) {
        rec.n += 1;
        const left = MAX_VERIFY_ATTEMPTS - rec.n;
        await env.CODES.put("c:" + email, JSON.stringify(rec), { expirationTtl: CODE_TTL });
        return json({ ok: false, error: "code_mismatch", message: left > 0 ? "验证码不正确，还可尝试 " + left + " 次" : "验证码已作废，请重新获取" }, 400, cors);
      }

      // 一次有效
      await env.CODES.delete("c:" + email);
      return json({ ok: true, message: "验证通过" }, 200, cors);
    }

    return json({ ok: false, error: "not_found" }, 404, cors);
  }
};
