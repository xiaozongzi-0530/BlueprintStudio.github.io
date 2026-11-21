/*!
 * 前端轻量限流 / 防刷（BlueprintStudio）
 *
 * ⚠️ 重要说明：这是「客户端软限流」，不是 DDoS 防护。
 *    真正的 DDoS 防护必须在服务端 / CDN 完成（限流、WAF、挑战验证、带宽清洗）。
 *    本文件的作用是：
 *      1. 挡住误触、连点、以及普通脚本对 UI 的无脑刷；
 *      2. 让「刷接口」的成本从「0 成本」提升到「需要抓包、绕过页面」。
 *    对已经拿到 textdb.dev 接口地址的攻击者，本文件不起作用。
 *
 * 用法：
 *   RLT.hit("forum-post", 30000, 3)        -> { ok:true } 或 { ok:false, msg:"...", wait:N }
 *   RLT.guard("forum-post", 30000, 3, fn)  -> 自动节流，超限时弹提示并跳过 fn
 */
(function (global) {
  "use strict";

  var PREFIX = "rlt_";

  /* 读取某动作的历史时间戳数组 */
  function load(key) {
    try {
      var v = JSON.parse(localStorage.getItem(PREFIX + key) || "[]");
      return Array.isArray(v) ? v.filter(function (t) { return typeof t === "number"; }) : [];
    } catch (e) { return []; }
  }
  function save(key, arr) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(arr)); } catch (e) {}
  }

  /**
   * 尝试执行一次动作（滑动窗口）
   * @param {string} key     动作名
   * @param {number} window  窗口毫秒，例如 60*1000
   * @param {number} max     窗口内最大次数
   * @param {number} [gap]   两次之间的最小间隔毫秒（可选，防连点）
   * @returns {{ok:boolean, msg?:string, wait?:number}}
   */
  function hit(key, window, max, gap) {
    var now = Date.now();
    var arr = load(key).filter(function (t) { return now - t < window; });

    if (gap && arr.length) {
      var last = arr[arr.length - 1];
      if (now - last < gap) {
        var wait = Math.ceil((gap - (now - last)) / 1000);
        return { ok: false, msg: "操作太频繁，请 " + (wait > 0 ? wait : 1) + " 秒后重试", wait: wait };
      }
    }
    if (arr.length >= max) {
      var freeAt = arr[0] + window;
      var mins = Math.max(1, Math.ceil((freeAt - now) / 60000));
      return {
        ok: false,
        msg: "操作太频繁（" + Math.round(window / 60000) + " 分钟内最多 " + max + " 次），请 " + mins + " 分钟后再试",
        wait: Math.ceil((freeAt - now) / 1000)
      };
    }
    arr.push(now);
    save(key, arr);
    return { ok: true };
  }

  /**
   * 节流包装：超限时提示并返回 false，否则执行 fn 并返回 true
   */
  function guard(key, window, max, gap, fn, onBlocked) {
    var r = hit(key, window, max, gap);
    if (!r.ok) {
      if (onBlocked) onBlocked(r);
      else if (typeof alert === "function") alert(r.msg);
      return false;
    }
    if (typeof fn === "function") fn();
    return true;
  }

  /* 字数/频率之外的通用校验：连续相同内容也可以拦（防复制粘贴刷屏） */
  function sameContent(key, text, window) {
    window = window || 60000;
    var now = Date.now();
    var k = key + "_last";
    try {
      var v = JSON.parse(localStorage.getItem(PREFIX + k) || "null");
      if (v && v.text === text && now - v.t < window) {
        var wait = Math.ceil((window - (now - v.t)) / 1000);
        return { ok: false, msg: "内容与上次相同，请 " + wait + " 秒后再发（防刷屏）" };
      }
      localStorage.setItem(PREFIX + k, JSON.stringify({ text: text, t: now }));
    } catch (e) {}
    return { ok: true };
  }

  global.RLT = { hit: hit, guard: guard, sameContent: sameContent };
})(window);
