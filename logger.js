/* ===== BlueprintStudio 前端错误日志采集 =====
   纯前端站点没有服务器，日志写到 textdb.dev 上一个独立的 key。
   只记录「错误本身 + 浏览器环境」，绝不读取任何输入框内容，
   密码、验证码、邮箱都不会进入日志。

   引入方式：在页面 <head> 里尽早引入
     <script src="logger.js"></script>
   手动上报：
     BPLog.error("api", "验证码发送失败: " + msg, { detail: "..." })
     BPLog.warn("ui", "……")   BPLog.info("ui", "……") */
(function () {
  "use strict";

  var LOG_DB = "https://textdb.dev/api/data/blueprintstudio-logs-v1";
  var MAX_KEEP = 100;      /* 云端最多保留 100 条，更早的自动丢弃 */
  var MAX_SESSION = 15;    /* 单次访问最多上报 15 条，防止死循环把库刷爆 */
  var DEDUP_MS = 60000;    /* 同一条错误 60 秒内只报一次 */
  var MSG_MAX = 240, STACK_MAX = 500, UA_MAX = 90;

  var sent = 0;
  var seen = {};
  var queue = Promise.resolve();

  function clip(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }
  function identity() {
    var o = {};
    try {
      o.uid = localStorage.getItem("bs_uid") || "";
      o.nick = localStorage.getItem("bs_nick") || "";
      if (localStorage.getItem("gs_mode") === "1") o.guest = true;
    } catch (e) {}
    return o;
  }
  function pageName() {
    var p = location.pathname.split("/").pop();
    return p || "index.html";
  }
  function allow(key) {
    if (sent >= MAX_SESSION) return false;
    var t = seen[key], now = Date.now();
    if (t && now - t < DEDUP_MS) return false;
    seen[key] = now;
    return true;
  }

  /* 攒批上报：4 秒内的多条错误合并成一次「读-改-写」。
     原来每条错误都单独跨境 GET+POST，textdb 单次 1~4 秒，几个错误就能把
     首屏的关键请求堵死；合并后正常情况一次访问只产生一轮请求。 */
  var BATCH_MS = 4000, FETCH_TIMEOUT = 8000;
  var pending = [], flushTimer = null, flushing = false;

  function fetchT(url, opt) {
    var ctrl = null, tid = null;
    if (typeof AbortController !== "undefined") {
      ctrl = new AbortController();
      opt = opt || {};
      opt.signal = ctrl.signal;
      tid = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, FETCH_TIMEOUT);
    }
    return fetch(url, opt).then(function (r) { if (tid) clearTimeout(tid); return r; },
      function (e) { if (tid) clearTimeout(tid); throw e; });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flush(); }, BATCH_MS);
  }

  function flush() {
    if (flushing || !pending.length) return;
    flushing = true;
    var batch = pending.splice(0, pending.length);
    queue = queue.then(function () {
      return fetchT(LOG_DB + "?t=" + Date.now(), { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (db) {
          var logs = (db && db.logs) || [];
          if (!Array.isArray(logs)) logs = [];
          var merged = batch.concat(logs);
          if (merged.length > MAX_KEEP) merged = merged.slice(0, MAX_KEEP);
          return fetchT(LOG_DB, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ logs: merged })
          });
        });
    }).catch(function () { /* 日志自身出错就放弃，绝不递归上报 */ })
      .then(function () { flushing = false; });
  }

  function send(rec) {
    sent++;
    pending.push(rec);
    scheduleFlush();
    return queue;
  }

  function report(level, src, msg, extra) {
    msg = clip(msg, MSG_MAX);
    if (!allow(src + "|" + msg)) return Promise.resolve();
    var rec = { t: new Date().toISOString(), lv: level, src: src, page: pageName(), msg: msg };
    if (extra && extra.stack) rec.stack = clip(extra.stack, STACK_MAX);
    if (extra && extra.detail) rec.detail = clip(extra.detail, 200);
    if (extra && extra.file) rec.file = clip(extra.file, 120);
    var id = identity();
    if (id.uid) rec.uid = id.uid;
    if (id.nick) rec.nick = clip(id.nick, 20);
    if (id.guest) rec.guest = true;
    rec.ua = clip(navigator.userAgent, UA_MAX);
    rec.v = 1;
    return send(rec);
  }

  window.BPLog = {
    error: function (src, msg, extra) { return report("error", src, msg, extra); },
    warn: function (src, msg, extra) { return report("warn", src, msg, extra); },
    info: function (src, msg, extra) { return report("info", src, msg, extra); }
  };

  /* 未捕获的脚本异常；capture 才收得到资源（img/script/link）加载失败 */
  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName && /^(IMG|SCRIPT|LINK|VIDEO|AUDIO)$/.test(t.tagName)) {
      report("warn", "resource", "资源加载失败: " + (t.src || t.href || t.tagName));
      return;
    }
    var err = e.error;
    report("error", "js", e.message || "未知脚本错误", {
      file: (e.filename || "") + (e.lineno ? ":" + e.lineno : ""),
      stack: err && err.stack ? err.stack : ""
    });
  }, true);

  /* 未处理的 Promise 拒绝 */
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    var msg = (r && r.message) ? r.message : String(r || "未处理的 Promise 拒绝");
    report("error", "promise", msg, { stack: (r && r.stack) ? r.stack : "" });
  });
})();
