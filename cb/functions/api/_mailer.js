/* 通用 SMTP 发信模块（CloudBase 云函数 ESM，零依赖）
   ------------------------------------------------------------
   只依赖 Node 内置 tls / crypto，无需 npm install。
   环境变量：
     SMTP_USER  发件邮箱，如 blueprintstudio@yeah.net
     SMTP_PASS  邮箱 SMTP 授权码（不是登录密码）
     SMTP_HOST  SMTP 主机（默认 smtp.yeah.net）
     SMTP_PORT  SMTP 端口（默认 465）
     SMTP_FROM  发件显示名（默认 BlueprintStudio）
   授权码只在云端环境变量，永不进仓库/前端。 */

import tls from "node:tls";
import crypto from "node:crypto";

const SMTP_HOST = process.env.SMTP_HOST || "smtp.yeah.net";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const FROM_NAME = process.env.SMTP_FROM || "BlueprintStudio";
/* EHLO 标识：网易 Coremail 反垃圾系统会校验，用 mail.<域名> 才能通过 AUTH */
const SMTP_EHLO = process.env.SMTP_EHLO ||
  ("mail." + String(SMTP_HOST).split(".").slice(-2).join("."));
const T_STEP = 6000;
const T_TOTAL = 12000;

function b64(s) { return Buffer.from(s, "utf8").toString("base64"); }
function wrap76(s) { return (s.match(/.{1,76}/g) || []).join("\r\n"); }
function encodeHeader(s) { return "=?UTF-8?B?" + b64(s) + "?="; }
function dotStuff(s) { return s.replace(/\r\n\./g, "\r\n..").replace(/^\./, ".."); }

function readReplyFactory(sock) {
  let buf = "";
  const waiters = [];
  function tryParse() {
    let pos = 0, code = null, endPos = -1;
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
  sock.on("error", (e) => { while (waiters.length) waiters.shift()(e); });
  sock.on("close", () => { while (waiters.length) waiters.shift()(new Error("连接已关闭")); });
  return function readReply(timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP 响应超时")), timeout || T_STEP);
      waiters.push((err, r) => { clearTimeout(timer); if (err) reject(err); else resolve(r); });
    });
  };
}

/* 构造 MIME 邮件（纯文本 + HTML 双份） */
function buildMessage(to, subject, text, html) {
  const boundary = "bs_" + crypto.randomBytes(8).toString("hex");
  const head = [
    'From: "' + encodeHeader(FROM_NAME) + '" <' + process.env.SMTP_USER + ">",
    "To: <" + to + ">",
    "Subject: " + encodeHeader(subject),
    "Date: " + new Date().toUTCString().replace("GMT", "+0000"),
    "Message-ID: <" + crypto.randomBytes(12).toString("hex") + "@" + SMTP_HOST + ">",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
  ].join("\r\n");
  const body =
    "\r\n\r\n--" + boundary + "\r\n" +
    "Content-Type: text/plain; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" + wrap76(b64(text)) + "\r\n" +
    "--" + boundary + "\r\n" +
    "Content-Type: text/html; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" + wrap76(b64(html)) + "\r\n" +
    "--" + boundary + "--\r\n";
  return head + body;
}

/* 发送邮件：sendMail({to, subject, text, html}) */
export function sendMail(to, subject, text, html) {
  return new Promise((resolve, reject) => {
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (!user || !pass) return reject(new Error("服务端未配置 SMTP_USER / SMTP_PASS"));

    let stage = "连接", done = false;
    const sock = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
    sock.setTimeout(T_STEP);
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      try { sock.destroy(); } catch (_) {}
      if (err) reject(err); else resolve();
    };
    const killer = setTimeout(() => finish(new Error(stage + "阶段超时")), T_TOTAL);
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
        await expect(220, "等待欢迎语");
        await write("EHLO " + SMTP_EHLO); await expect(250, "握手");
        await write("AUTH LOGIN"); await expect(334, "认证");
        await write(b64(user)); await expect(334, "认证");
        await write(b64(pass)); await expect(235, "登录");
        await write("MAIL FROM:<" + user + ">"); await expect(250, "发件人");
        await write("RCPT TO:<" + to + ">"); await expect([250, 251], "收件人");
        await write("DATA"); await expect(354, "准备正文");
        await write(dotStuff(buildMessage(to, subject, text, html)) + "\r\n.");
        await expect(250, "投递");
        stage = "退出";
        await write("QUIT").catch(() => {});
        finish(null);
      } catch (e) { finish(e); }
    });
  });
}

/* 是否配置了发信通道 */
export function mailConfigured() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}
