/**
 * BlueprintStudio · P2P 附件模块
 * ================================================================
 * 用途：论坛 / 笔记 / 聊天 / 发现页的大型附件，不再把 base64 塞进数据库，
 *      改为浏览器之间 WebRTC 直传（点对点），服务器不存文件字节。
 *
 * 设计：
 *  1. 小文件（≤ 各页 threshold）照旧内嵌 dataURL —— 任何人任何时候都能看，
 *     这是"历史帖子发帖人早就下线了"的兜底。
 *  2. 大文件：上传页把 Blob 存进浏览器 IndexedDB，然后用 PeerJS 以
 *     「bsf-<fileId>」这个固定 ID 上线做种；帖子/笔记/聊天里只存
 *     {name,type,size,p2p:{id}} 这点元信息。
 *  3. 下载者点附件 → 连 bsf-<fileId> → 分片收完 → 存进自己的 IndexedDB
 *     并自动开始做种。也就是说**下载过的人会接棒当种子**，
 *     发帖人下线后只要有人下载过，文件依然活着。
 *  4. 完全没人做种时给出明确提示，不假装能下。
 *
 * 对外接口：
 *   P2PFile.prepare(file, {inlineMax})  -> Promise<meta>
 *   P2PFile.attrs(meta)                 -> 'href="data:..." download="x"' 或 'data-p2p="id"'
 *   P2PFile.isP2P(meta)                 -> bool
 *   P2PFile.url(meta)                   -> dataURL（仅内嵌文件）或 ""
 *   P2PFile.download(meta)              -> Promise<Blob>
 *   P2PFile.boot()                      -> 页面加载后自动调用（自动执行）
 */
(function (global) {
  "use strict";

  var PEER_CDN = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
  var CHUNK = 64 * 1024;          // 64KB 一片，兼顾吞吐和内存
  var P2P_MAX = 30 * 1024 * 1024; // 单文件 P2P 上限 30MB
  var CONNECT_TIMEOUT = 12000;    // 12 秒连不上就算这个种子不可用

  /* ================= IndexedDB：本地文件库（做种用） ================= */

  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (res, rej) {
      var r = indexedDB.open("bs-p2p-files", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("files", { keyPath: "id" }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbPromise;
  }
  function idb(op, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var tx = d.transaction("files", op);
        var req = fn(tx.objectStore("files"));
        tx.oncomplete = function () { res(req && req.result); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  var idbPut = function (rec) { return idb("readwrite", function (s) { return s.put(rec); }); };
  var idbGet = function (id) { return idb("readonly", function (s) { return s.get(id); }); };
  var idbAll = function () { return idb("readonly", function (s) { return s.getAll(); }); };

  /* ================= PeerJS 加载 ================= */

  var peerLibPromise = null;
  function loadPeerLib() {
    if (global.Peer) return Promise.resolve(global.Peer);
    if (peerLibPromise) return peerLibPromise;
    peerLibPromise = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = PEER_CDN;
      s.onload = function () { global.Peer ? res(global.Peer) : rej(new Error("PeerJS 加载异常")); };
      s.onerror = function () { rej(new Error("PeerJS 加载失败（可能是网络拦截）")); };
      document.head.appendChild(s);
    });
    return peerLibPromise;
  }

  function rid(n) {
    var s = "", a = new Uint8Array(n || 8);
    (global.crypto || global.msCrypto).getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, "0");
    return s;
  }

  /* ================= 做种 ================= */

  var seeders = {};   // fileId -> Peer 实例

  /**
   * 让本页为某个文件做种。ID 固定为 bsf-<fileId>，
   * 因此同一时刻全局只有一个种子；被占用时说明已经有别人在供源，直接跳过。
   */
  function seed(fileId) {
    if (seeders[fileId]) return Promise.resolve(seeders[fileId]);
    return loadPeerLib().then(function (Peer) {
      return new Promise(function (resolve) {
        var p;
        try { p = new Peer("bsf-" + fileId); }
        catch (e) { resolve(null); return; }
        var settled = false;
        p.on("open", function () {
          seeders[fileId] = p;
          settled = true;
          resolve(p);
        });
        p.on("connection", function (conn) { serve(conn, fileId); });
        p.on("error", function (e) {
          if (e && (e.type === "unavailable-id" || e.type === "browser-incompatible")) {
            /* 抢不到做种位 / 浏览器不支持 WebRTC：静默降级，不打扰用户 */
            try { p.destroy(); } catch (_) {}
            if (!settled) { settled = true; resolve(null); }
          } else if (!settled) {
            settled = true;
            resolve(null);
          }
        });
        setTimeout(function () { if (!settled) { settled = true; resolve(seeders[fileId] || null); } }, 8000);
      });
    }).catch(function () { return null; });
  }

  /** 有人来取文件：先发元信息，再按 64KB 分片推流，最后发结束标记 */
  function serve(conn, fileId) {
    conn.on("open", function () {
      idbGet(fileId).then(function (rec) {
        if (!rec || !rec.blob) { conn.send({ t: "err", m: "本机没有这个文件的副本" }); return; }
        var blob = rec.blob;
        conn.send({ t: "meta", name: rec.name, size: blob.size, type: rec.type || "application/octet-stream" });
        readAll(blob).then(function (buf) {
          var off = 0;
          (function next() {
            if (!conn.open) return;
            if (off >= buf.length) { conn.send({ t: "end" }); return; }
            var end = Math.min(off + CHUNK, buf.length);
            conn.send(buf.subarray(off, end));
            off = end;
            /* 背压控制：缓冲区堆积超过 4MB 就等一会儿，避免把手机内存打爆 */
            var dc = conn.dataChannel;
            var wait = dc && dc.bufferedAmount > 4 * 1024 * 1024 ? 60 : 0;
            setTimeout(next, wait);
          })();
        });
      }).catch(function () {
        try { conn.send({ t: "err", m: "读取本地副本失败" }); } catch (_) {}
      });
    });
  }

  function readAll(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(new Uint8Array(r.result)); };
      r.onerror = rej;
      r.readAsArrayBuffer(blob);
    });
  }

  /* ================= 下载 ================= */

  function connectToSeeder(fileId, onProgress) {
    return loadPeerLib().then(function (Peer) {
      return new Promise(function (resolve, reject) {
        var p = new Peer("bsfd-" + rid(6));   // 下载方每次用临时 ID
        var done = false, conn = null;

        function fail(msg) {
          if (done) return;
          done = true;
          try { conn && conn.close(); } catch (_) {}
          try { p.destroy(); } catch (_) {}
          reject(new Error(msg));
        }

        p.on("open", function () {
          conn = p.connect("bsf-" + fileId, { reliable: true });
          var parts = [], got = 0, total = 0, name = "download", type = "";

          conn.on("data", function (d) {
            if (d instanceof ArrayBuffer) d = new Uint8Array(d);
            if (d && d.t === "meta") {
              total = d.size; name = d.name || name; type = d.type || "";
              onProgress && onProgress(0, total);
            } else if (d && d.t === "err") {
              fail(d.m || "对方拒绝了请求");
            } else if (d && d.t === "end") {
              if (done) return;
              done = true;
              var blob = new Blob(parts, { type: type || "application/octet-stream" });
              try { conn.close(); } catch (_) {}
              try { p.destroy(); } catch (_) {}
              resolve({ blob: blob, name: name, type: type });
            } else if (d instanceof Uint8Array) {
              parts.push(d);
              got += d.length;
              onProgress && onProgress(got, total || got);
            }
          });

          conn.on("error", function () { fail("传输中断"); });
          conn.on("close", function () { if (!done) fail("对方断开了连接"); });

          setTimeout(function () { if (!done && !got) fail("对方没有响应"); }, CONNECT_TIMEOUT);
        });

        p.on("error", function (e) {
          var t = e && e.type;
          if (t === "peer-unavailable") fail("暂无人在线做种");
          else if (!done) fail((e && e.message) || "连接失败");
        });

        setTimeout(function () { if (!done) fail("连接超时（可能需要检查网络是否允许 WebRTC）"); }, CONNECT_TIMEOUT + 6000);
      });
    });
  }

  /** 下载：成功后写本地库并接棒做种 */
  function download(meta) {
    var id = meta && meta.p2p && meta.p2p.id;
    if (!id) {
      /* 内嵌文件：把 dataURL 还原成 Blob */
      return Promise.resolve(dataUrlToBlob(meta.data)).then(function (b) {
        if (!b) throw new Error("附件数据损坏");
        return { blob: b, name: meta.name, type: meta.type };
      });
    }
    return withUI(meta, function (progress) {
      return connectToSeeder(id, progress).then(function (r) {
        /* 存本地 → 以后即使原发帖人不在线，本机也能继续供源 */
        idbPut({
          id: id, name: r.name, type: r.type, blob: r.blob,
          size: r.blob.size, at: Date.now()
        }).then(function () { seed(id); }).catch(function () {});
        return r;
      });
    });
  }

  function dataUrlToBlob(du) {
    var parts = String(du || "").split(",");
    if (parts.length < 2) return null;
    var mime = (parts[0].match(/:(.*?);/) || [])[1] || "application/octet-stream";
    try {
      var bin = atob(parts[1]);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    } catch (e) { return null; }
  }

  /* ================= 下载进度浮层 ================= */

  function fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(2) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }

  function withUI(meta, task) {
    var box = document.createElement("div");
    box.style.cssText = "position:fixed;left:50%;bottom:2rem;transform:translateX(-50%);z-index:99999;"
      + "background:#111731;color:#e6ebf5;border:1px solid rgba(79,124,255,.45);border-radius:14px;"
      + "padding:1rem 1.2rem;min-width:280px;max-width:90vw;font-size:.88rem;"
      + "box-shadow:0 12px 40px rgba(0,0,0,.45);font-family:-apple-system,'Microsoft YaHei',sans-serif;";
    box.innerHTML = '<div style="margin-bottom:.55rem;">📡 P2P 接收中：<b>' + esc(meta.name || "附件") + "</b></div>"
      + '<div style="height:6px;background:rgba(255,255,255,.12);border-radius:999px;overflow:hidden;">'
      + '<div class="bar" style="height:100%;width:0;background:linear-gradient(90deg,#4f7cff,#22d3ee);transition:width .2s;"></div></div>'
      + '<div class="tip" style="margin-top:.5rem;color:#8a93a8;">正在寻找做种者…</div>';
    document.body.appendChild(box);
    var bar = box.querySelector(".bar"), tip = box.querySelector(".tip");

    return task(function (got, total) {
      var pct = total ? Math.min(100, got / total * 100) : 0;
      bar.style.width = pct.toFixed(1) + "%";
      tip.textContent = "已接收 " + fmtSize(got) + " / " + fmtSize(total) + "（" + pct.toFixed(0) + "%）";
    }).then(function (r) {
      bar.style.width = "100%";
      tip.textContent = "✅ 接收完成，正在保存…";
      setTimeout(function () { box.remove(); }, 900);
      return r;
    }).catch(function (e) {
      tip.innerHTML = '<span style="color:#ff8a8a;">❌ ' + esc(e.message || "下载失败") + "</span>"
        + '<br><span style="color:#8a93a8;">P2P 需要有人在线做种；可稍后再试，或联系发布者</span>';
      setTimeout(function () { box.remove(); }, 6000);
      throw e;
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (m) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
    });
  }

  /* ================= 上传准备 ================= */

  /**
   * 小文件返回内嵌 meta，大文件存本地 + 开始做种并返回 P2P meta。
   * 返回值可直接塞进帖子/笔记/消息的 files 数组，格式向后兼容。
   */
  function prepare(file, opts) {
    opts = opts || {};
    var inlineMax = opts.inlineMax || 300 * 1024;
    return new Promise(function (resolve, reject) {
      if (file.size > P2P_MAX) {
        reject(new Error("「" + file.name + "」超过 " + fmtSize(P2P_MAX) + " 上限"));
        return;
      }
      if (file.size <= inlineMax) {
        var r = new FileReader();
        r.onload = function () {
          resolve({
            name: file.name, type: file.type || "application/octet-stream",
            size: file.size, data: r.result
          });
        };
        r.onerror = function () { reject(new Error("读取文件失败")); };
        r.readAsDataURL(file);
        return;
      }
      var id = rid(8);   // 16 位十六进制，同时用作 PeerJS 房间名
      idbPut({
        id: id, name: file.name, type: file.type || "application/octet-stream",
        blob: file, size: file.size, at: Date.now()
      }).then(function () {
        seed(id);        // 后台做种，失败也不影响发帖
        resolve({
          name: file.name, type: file.type || "application/octet-stream",
          size: file.size, p2p: { id: id }
        });
      }).catch(function () {
        reject(new Error("本地缓存失败（可能是隐私模式），无法使用 P2P 传输"));
      });
    });
  }

  /* ================= 渲染与点击 ================= */

  function isP2P(meta) { return !!(meta && meta.p2p && meta.p2p.id); }

  function url(meta) {
    if (isP2P(meta)) return "";
    return (meta && meta.data) || "";
  }

  /** 生成 <a> 需要的属性：内嵌走 href，P2P 走 data-p2p 交给全局点击拦截 */
  function attrs(meta) {
    if (!meta) return "";
    if (isP2P(meta)) {
      return 'data-p2p="' + esc(meta.p2p.id) + '" data-p2p-name="' + esc(meta.name) + '"';
    }
    return 'href="' + meta.data + '" download="' + esc(meta.name) + '"';
  }

  /** 触发浏览器保存 */
  function save(blob, name) {
    var u = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = u;
    a.download = name || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 10000);
  }

  /* 全局点击拦截：任何带 data-p2p 的元素都走 P2P 下载 */
  function installClickHandler() {
    document.addEventListener("click", function (e) {
      var el = e.target && e.target.closest ? e.target.closest("[data-p2p]") : null;
      if (!el) return;
      e.preventDefault();
      var id = el.getAttribute("data-p2p");
      if (el.dataset.busy === "1") return;
      el.dataset.busy = "1";
      download({ p2p: { id: id }, name: el.getAttribute("data-p2p-name") || "附件" })
        .then(function (r) { save(r.blob, r.name); })
        .catch(function () { /* 浮层已经给了提示 */ })
        .then(function () { delete el.dataset.busy; });
    }, true);
  }

  /* 页面加载时，把本机缓存过的文件重新挂上去做种（接棒供源） */
  function resumeSeeding() {
    idbAll().then(function (list) {
      (list || []).forEach(function (rec) {
        if (rec && rec.id && rec.blob) seed(rec.id);
      });
    }).catch(function () {});
  }

  var booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    installClickHandler();
    if ("indexedDB" in global) resumeSeeding();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  global.P2PFile = {
    prepare: prepare,
    attrs: attrs,
    url: url,
    isP2P: isP2P,
    download: download,
    save: save,
    fmtSize: fmtSize,
    max: P2P_MAX
  };
})(window);
