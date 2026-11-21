/**
 * BlueprintStudio · 邮箱验证码发信函数（Netlify Function）
 *
 * 设计要点：
 *  1. 零依赖：只用 Node 内置的 tls / crypto，不需要 npm install，部署最省事。
 *  2. SMTP 授权码只存在于 Netlify 环境变量里，永远不下发到浏览器。
 *  3. 只接受「收件邮箱 + 6 位验证码」，正文模板写死，无法被当作任意邮件发送器。
 *  4. 校验 Origin，只允许站点自身与本地调试调用。
 *
 * 环境变量（Netlify → Site configuration → Environment variables）：
 *  SMTP_USER = blueprintstudio@yeah.net
 *  SMTP_PASS = 邮箱授权码
 */

const tls = require("node:tls");
const crypto = require("node:crypto");

const SMTP_HOST = "smtp.yeah.net";
const SMTP_PORT = 465;
const FROM_NAME = "BlueprintStudio";
const SITE_NAME = "BlueprintStudio";
const CODE_TTL_MIN = 10;

const T_STEP = 6000;    // 单步超时
const T_TOTAL = 8500;   // 整体超时（Netlify 免费版同步函数上限 10 秒）

const ALLOW_EXACT = ["https://xiaozongzi-0530.github.io"];
const ALLOW_RE = [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

/* ---------------- 限流：进程内计数，冷启动会重置，只作基础拦截 ---------------- */
const hits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { min: [], hour: [] };
  rec.min = rec.min.filter((t) => now - t < 60000);
  rec.hour = rec.hour.filter((t) => now - t < 3600000);
  if (rec.min.length >= 3) return "请求过于频繁，请 1 分钟后再试";
  if (rec.hour.length >= 10) return "今天获取验证码的次数过多，请稍后再试";
  rec.min.push(now);
  rec.hour.push(now);
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  return null;
}

function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(body, status, origin) {
  return {
    statusCode: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsHeaders(origin)),
    body: JSON.stringify(body),
  };
}

/* ---------------- SMTP 客户端 ---------------- */
function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

function wrap76(s) {
  return (s.match(/.{1,76}/g) || []).join("\r\n");
}

function encodeHeader(s) {
  return "=?UTF-8?B?" + b64(s) + "?=";
}

function dotStuff(s) {
  return s.replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
}

function readReplyFactory(sock) {
  let buf = "";
  const waiters = [];

  function tryParse() {
    let pos = 0;
    let code = null;
    let endPos = -1;
    for (;;) {
      const nl = buf.indexOf("\r\n", pos);
      if (nl < 0) return null;
      const line = buf.slice(pos, nl);
      if (!/^\d{3}([ -]|$)/.test(line)) return null;
      if (code === null) code = parseInt(line.slice(0, 3), 10);
      pos = nl + 2;
      if (line.length === 3 || line[3] !== "-") { endPos = pos; break; }
    }
    if (endPos < 0) return null;
    const text = buf.slice(0, endPos).replace(/\r\n$/, "").replace(/\r\n/g, " | ");
    buf = buf.slice(endPos);
    return { code, text };
  }

  sock.on("data", (d) => {
    buf += d.toString("utf8");
    for (;;) {
      if (!waiters.length) break;
      const r = tryParse();
      if (!r) break;
      waiters.shift()(null, r);
    }
  });
  sock.on("error", (e) => {
    while (waiters.length) waiters.shift()(e);
  });
  sock.on("close", () => {
    while (waiters.length) waiters.shift()(new Error("连接已关闭"));
  });

  return function readReply(timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP 响应超时")), timeout || T_STEP);
      waiters.push((err, r) => {
        clearTimeout(timer);
        if (err) reject(err); else resolve(r);
      });
    });
  };
}

function buildMessage(to, code) {
  const boundary = "bs_" + crypto.randomBytes(8).toString("hex");
  const subject = SITE_NAME + " 邮箱验证码";
  const text =
    "你好，\n\n你的 " + SITE_NAME + " 验证码是： " + code + "\n\n" +
    "有效期 " + CODE_TTL_MIN + " 分钟。若非本人操作，请忽略本邮件。\n";
  const html =
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;color:#111">' +
    "<p>你好，</p>" +
    "<p>你的 " + SITE_NAME + " 验证码是：</p>" +
    '<p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:18px 0;color:#2b5cff">' + code + "</p>" +
    "<p>有效期 " + CODE_TTL_MIN + " 分钟。若非本人操作，请忽略本邮件。</p>" +
    '<p style="color:#888;font-size:12px;margin-top:24px">此邮件由系统自动发送，请勿直接回复。</p>' +
    "</div>";

  const head = [
    'From: "' + encodeHeader(FROM_NAME) + '" <' + process.env.SMTP_USER + ">",
    "To: <" + to + ">",
    "Subject: " + encodeHeader(subject),
    "Date: " + new Date().toUTCString().replace("GMT", "+0000"),
    "Message-ID: <" + crypto.randomBytes(12).toString("hex") + "@yeah.net>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
  ].join("\r\n");

  const body =
    "\r\n\r\n--" + boundary + "\r\n" +
    "Content-Type: text/plain; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    wrap76(b64(text)) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: text/html; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n" +
    "\r\n" +
    wrap76(b64(html)) + "\r\n" +
    "--" + boundary + "--\r\n";

  return head + body;
}

function sendMail(to, code) {
  return new Promise((resolve, reject) => {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!user || !pass) {
      return reject(new Error("服务端未配置 SMTP_USER / SMTP_PASS"));
    }

    let stage = "连接";
    let done = false;
    const sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    sock.setTimeout(T_STEP);

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      try { sock.destroy(); } catch (_) {}
      if (err) reject(err); else resolve();
    };

    const killer = setTimeout(() => finish(new Error(stage + "阶段超时（" + T_TOTAL / 1000 + " 秒）")), T_TOTAL);

    sock.on("error", (e) => finish(new Error(stage + "失败：" + e.message)));
    sock.on("timeout", () => finish(new Error(stage + "超时，服务器无响应")));

    const read = readReplyFactory(sock);

    async function expect(want, name) {
      stage = name;
      const r = await read();
      const ok = Array.isArray(want) ? want.includes(r.code) : r.code === want;
      if (!ok) throw new Error(name + "失败(" + r.code + ")：" + String(r.text).slice(0, 140));
      return r;
    }

    const write = (s) => new Promise((res, rej) => sock.write(s + "\r\n", (e) => (e ? rej(e) : res())));

    sock.on("secureConnect", async () => {
      try {
        await expect(220, "等待服务器欢迎语");
        await write("EHLO blueprintstudio");
        await expect(250, "握手");

        await write("AUTH LOGIN");
        await expect(334, "认证");
        await write(b64(user));
        await expect(334, "认证");
        await write(b64(pass));
        await expect(235, "登录");

        await write("MAIL FROM:<" + user + ">");
        await expect(250, "发件人");
        await write("RCPT TO:<" + to + ">");
        await expect([250, 251], "收件人");
        await write("DATA");
        await expect(354, "准备正文");

        /* DATA 必须以单独一行的 "." 结束，缺了这句服务器会一直等下去 */
        await write(dotStuff(buildMessage(to, code)) + "\r\n.");
        await expect(250, "投递");

        stage = "退出";
        await write("QUIT").catch(() => {});
        finish(null);
      } catch (e) {
        finish(e);
      }
    });
  });
}

/* ---------------- 入口 ---------------- */
exports.handler = async function (event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const allowed = !origin || ALLOW_EXACT.includes(origin) || ALLOW_RE.some((re) => re.test(origin));

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(allowed ? origin : ""), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return json({ ok: false, message: "只支持 POST" }, 405, allowed ? origin : "");
  }
  if (!allowed) {
    return json({ ok: false, message: "来源不被允许" }, 403, "");
  }

  let payload = {};
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return json({ ok: false, message: "请求格式错误" }, 400, origin);
  }

  const email = String(payload.email || "").trim().toLowerCase();
  const code = String(payload.code || "").trim();

  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email) || email.length > 120) {
    return json({ ok: false, message: "邮箱格式不正确" }, 400, origin);
  }
  if (!/^[1-9]\d{5}$/.test(code)) {
    return json({ ok: false, message: "验证码格式不正确" }, 400, origin);
  }

  const ip =
    (event.headers && (event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"])) || "unknown";
  const limited = rateLimit(String(ip).split(",")[0].trim());
  if (limited) {
    return json({ ok: false, message: limited }, 429, origin);
  }

  try {
    await sendMail(email, code);
    console.log("[send-code] ok ->", email);
    return json({ ok: true }, 200, origin);
  } catch (e) {
    console.error("[send-code] fail ->", email, e && e.message);
    const msg = String((e && e.message) || "");
    const human = /未配置/.test(msg)
      ? "服务端未完成配置，请联系管理员"
      : /登录失败/.test(msg)
      ? "邮箱登录失败，请稍后再试"
      : /超时/.test(msg)
      ? "发信超时，请稍后再试"
      : "邮件发送失败，请稍后再试";
    return json({ ok: false, message: human }, 502, origin);
  }
};
