/**
 * BlueprintStudio 数据服务接入层
 * ------------------------------------------------------------
 * 把原来直连 textdb.dev 的读写切换到自己的 API（Netlify Functions + Blobs）：
 *   BP.get(key)              读数据（公开，格式与旧 textdb 一致）
 *   BP.put(key, obj)         写数据（自动附带登录 token；游客写由服务端限流）
 *   BP.auth({action,...})    账号操作（login/register/list/nick/grant/ban）
 *   BP.uploadFile(file)      上传附件（≤5MB，二进制，返回 {id,...}）
 *   BP.fileURL(id)           附件下载地址
 * token 首次登录时获得，7 天有效，存 localStorage。
 */
(function (global) {
  "use strict";

  var BASE = "https://blueprintstudio-mail.netlify.app";
  var TOKEN_KEY = "bs_token_v1";

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  function setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  function authHeaders() {
    var t = token();
    return t ? { "Authorization": "Bearer " + t } : {};
  }

  /* 读：兼容旧代码「返回整个 JSON 对象」的用法 */
  function get(key) {
    return fetch(BASE + "/api/data?key=" + encodeURIComponent(key) + "&t=" + Date.now(), {
      cache: "no-store",
    }).then(function (r) { return r.json(); });
  }

  /* 写：obj 传对象或字符串 */
  function put(key, obj) {
    return fetch(BASE + "/api/data", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({ key: key, data: typeof obj === "string" ? obj : JSON.stringify(obj) }),
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return { msg: "HTTP " + r.status }; })
          .then(function (e) { throw new Error(e.msg || ("写入失败 HTTP " + r.status)); });
      }
      return r.json();
    });
  }

  /* 账号操作 */
  function auth(payload) {
    return fetch(BASE + "/api/auth", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); });
  }

  /* 附件上传：二进制 multipart，不再 base64 塞 JSON */
  function uploadFile(file) {
    var fd = new FormData();
    fd.append("file", file, file.name);
    return fetch(BASE + "/api/file", {
      method: "POST",
      headers: authHeaders(),
      body: fd,
    }).then(function (r) { return r.json(); });
  }

  /* 图片压缩：超过 600KB 的图片压到 1600px / 质量 0.82，其他类型原样上传 */
  function compressImage(file) {
    if (!/^image\//.test(file.type) || file.size < 600 * 1024) return Promise.resolve(file);
    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        try {
          var maxW = 1600, w = img.width, h = img.height;
          if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
          var cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          cv.getContext("2d").drawImage(img, 0, 0, w, h);
          cv.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (blob && blob.size < file.size) {
              resolve(new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }));
            } else resolve(file);
          }, "image/jpeg", 0.82);
        } catch (e) { URL.revokeObjectURL(url); resolve(file); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  global.BPApi = {
    BASE: BASE,
    get: get,
    put: put,
    auth: auth,
    uploadFile: uploadFile,
    compressImage: compressImage,
    fileURL: function (id) { return BASE + "/api/file?id=" + encodeURIComponent(id); },
    token: token,
    setToken: setToken,
    isLogged: function () { return !!token(); },
  };
})(window);
