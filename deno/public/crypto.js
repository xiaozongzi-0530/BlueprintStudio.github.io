/**
 * BlueprintStudio 前端加密模块 (E2EE)
 * ------------------------------------------------------------
 * 设计要点：
 * 1. 传输层：所有数据在离开浏览器前即被 AES-GCM 加密，服务端只能看到密文。
 * 2. 密钥派生：使用 PBKDF2-SHA256 从「上下文串」派生，上下文由
 *    站点固定盐 + 具体用途（如一对用户的 UID）组成。
 *    同一对用户派生同一密钥 -> 双方可互相解密，无需交换密钥。
 * 3. 随机性：每条密文使用独立随机 IV，相同明文多次加密结果不同。
 * 4. 完整性：AES-GCM 自带认证标签，密文被篡改会解密失败。
 *
 * 安全边界（务必知悉）：
 * 本方案能防止「直接读取数据库/抓包」拿到明文，但站点公共盐写在
 * 前端源码中，能拿到源码且有针对性的人理论上可构造密钥。
 * 它显著提高了窃取门槛，但不等于「零知识」级别的企业级 E2EE。
 */
(function (global) {
  "use strict";

  var SITE_SALT = "BlueprintStudio::2026::e2ee::v2";   // 站点固定盐
  var PBKDF2_ITER = 150000;                             // 迭代次数
  var _keyCache = {};                                   // 派生的 CryptoKey 缓存

  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function b64(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(str) {
    var bin = atob(str), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* 从上下文串派生 AES-GCM 密钥（带缓存） */
  function deriveKey(context) {
    var id = SITE_SALT + "|" + context;
    if (_keyCache[id]) return Promise.resolve(_keyCache[id]);
    var baseKey = crypto.subtle.importKey(
      "raw", enc.encode(SITE_SALT), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return baseKey.then(function (k) {
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode(context), iterations: PBKDF2_ITER, hash: "SHA-256" },
        k,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
    }).then(function (key) {
      _keyCache[id] = key;
      return key;
    });
  }

  /* 加密字符串 -> "v2:<iv>:<cipher>" 形式的可存字符串 */
  function encrypt(plain, context) {
    if (plain === undefined || plain === null) return Promise.resolve(plain);
    var text = String(plain);
    return deriveKey(context).then(function (key) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, enc.encode(text))
        .then(function (ct) {
          return "v2:" + b64(iv) + ":" + b64(ct);
        });
    });
  }

  /* 解密；非 v2 前缀的旧明文原样返回（便于兼容） */
  function decrypt(payload, context) {
    if (typeof payload !== "string" || payload.indexOf("v2:") !== 0) {
      return Promise.resolve(payload);
    }
    var parts = payload.split(":");
    if (parts.length !== 3) return Promise.resolve("[解密失败]");
    var iv, ct;
    try { iv = unb64(parts[1]); ct = unb64(parts[2]); }
    catch (e) { return Promise.resolve("[解密失败]"); }
    return deriveKey(context).then(function (key) {
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct)
        .then(function (buf) { return dec.decode(buf); })
        .catch(function () { return "[解密失败]"; });
    });
  }

  /* 对象字段批量加密：fields 为需要加密的键名数组 */
  function encryptFields(obj, fields, context) {
    if (!obj) return Promise.resolve(obj);
    var copy = {};
    Object.keys(obj).forEach(function (k) { copy[k] = obj[k]; });
    return Promise.all(fields.map(function (f) {
      if (copy[f] === undefined || copy[f] === null) return null;
      return encrypt(copy[f], context + "|" + f).then(function (v) { copy[f] = v; });
    })).then(function () { return copy; });
  }

  /* 对象字段批量解密 */
  function decryptFields(obj, fields, context) {
    if (!obj) return Promise.resolve(obj);
    var copy = {};
    Object.keys(obj).forEach(function (k) { copy[k] = obj[k]; });
    return Promise.all(fields.map(function (f) {
      if (copy[f] === undefined || copy[f] === null) return null;
      return decrypt(copy[f], context + "|" + f).then(function (v) { copy[f] = v; });
    })).then(function () { return copy; });
  }

  /* 密码哈希：PBKDF2 加盐，替代原来的单轮 SHA-256 */
  function hashPassword(email, password) {
    var saltStr = "bp-pw::" + String(email).toLowerCase();
    return crypto.subtle.importKey(
      "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]
    ).then(function (k) {
      return crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: enc.encode(saltStr), iterations: PBKDF2_ITER, hash: "SHA-256" },
        k, 256
      );
    }).then(function (bits) {
      return Array.prototype.map.call(new Uint8Array(bits), function (x) {
        return ("0" + x.toString(16)).slice(-2);
      }).join("");
    });
  }

  /* 生成一对用户的会话密钥上下文 */
  function pairContext(uidA, uidB) {
    return "chat::" + [String(uidA), String(uidB)].sort().join("|");
  }

  global.BPCrypto = {
    encrypt: encrypt,
    decrypt: decrypt,
    encryptFields: encryptFields,
    decryptFields: decryptFields,
    hashPassword: hashPassword,
    pairContext: pairContext,
    b64: b64,
    unb64: unb64,
    PBKDF2_ITER: PBKDF2_ITER
  };
})(window);
