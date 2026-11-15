/**
 * BlueprintStudio · AI 内容审核接入层
 * ------------------------------------------------------------
 * BPMod.check(text, kind)          发帖/笔记/聊天/发布前过 AI 审
 *      -> Promise<{clean, reason, skipped?, error?}>
 *      服务异常时宁可放过不可错杀（fail-open），error 字段带原因
 *
 * BPMod.appeal(payload)            提交人工申诉（AI 误判时）
 *      payload: {kind, content, aiReason, who}
 *
 * BPMod.blockDialog(text, kind, who, verdict)  统一的"违规拦截 + 申诉"弹窗
 *      返回 Promise<"appealed"|"dismissed">
 *
 * BPMod.listAppeals(token)         管理员：申诉列表
 * BPMod.resolveAppeal(token, id, outcome)  管理员：处理申诉
 *
 * BPMod.report(payload)           用户举报内容（AI 初判 + 管理员人工复核）
 *      payload: {kind, content, reportReason, who}
 *      -> Promise<{ok, ai:{violates,category,reason}, aiSkipped?, msg}>
 *
 * BPMod.listReports(token)         管理员：举报列表（含 AI 初判结果）
 * BPMod.resolveReport(token, id, outcome)  管理员：人工判定举报
 *
 * 审核模型：智谱 GLM（glm-4-flash，免费），由 Netlify 函数 /api/moderate 代理，
 * API Key 只存在服务端环境变量，前端拿不到。
 */
(function (global) {
  "use strict";

  var BASE = "https://blueprintstudio-mail.netlify.app";
  var KIND_NAME = { forum: "论坛帖子", note: "笔记", chat: "聊天消息", discover: "作品发布" };

  function call(path, body, token, method) {
    var headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(BASE + path, {
      method: method || "POST",
      headers: headers,
      body: method === "GET" ? undefined : JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  /* ---------- 审核 ---------- */
  function check(text, kind) {
    text = String(text || "").slice(0, 6000);
    if (!text.trim()) return Promise.resolve({ clean: true, reason: "" });
    return call("/api/moderate", { kind: kind || "text", text: text })
      .then(function (r) {
        if (r && r.ok) {
          return { clean: r.clean !== false, reason: r.reason || "", skipped: !!r.skipped };
        }
        return { clean: true, reason: "", error: (r && r.msg) || "审核服务异常" };
      })
      .catch(function () {
        return { clean: true, reason: "", error: "审核服务不可达" };
      });
  }

  /* ---------- 申诉 ---------- */
  function appeal(payload) {
    payload = payload || {};
    return call("/api/appeal", {
      kind: payload.kind || "",
      content: String(payload.content || "").slice(0, 6000),
      aiReason: payload.aiReason || "",
      who: payload.who || "",
    });
  }

  /* ---------- 举报（AI 初判 + 人工复核） ---------- */
  function report(payload) {
    payload = payload || {};
    return call("/api/report", {
      kind: payload.kind || "",
      content: String(payload.content || "").slice(0, 6000),
      reportReason: String(payload.reportReason || "").slice(0, 500),
      who: payload.who || "",
      target: String(payload.target || "").slice(0, 120),
      targetId: String(payload.targetId || "").slice(0, 80),
    });
  }

  /* ---------- 统一拦截弹窗：违规提示 + 是否申诉 ---------- */
  function blockDialog(text, kind, who, verdict) {
    var name = KIND_NAME[kind] || "内容";
    var msg = "🤖 AI 审核未通过（" + name + "）\n\n"
      + "判定理由：" + (verdict.reason || "疑似违规内容") + "\n\n"
      + "如你认为这是误判，可以提交申诉，由管理员人工复核。是否申诉？";
    if (!global.confirm(msg)) return Promise.resolve("dismissed");
    /* 走 BPMod.appeal 而不是内部闭包，便于页面/测试环境替换 */
    return global.BPMod.appeal({ kind: kind, content: text, aiReason: verdict.reason, who: who })
      .then(function (r) {
        global.alert((r && r.msg) || "申诉已提交，管理员将在 3 个工作日内人工处理。\n也可发邮件到 blueprintstudio@yeah.net 补充说明。");
        return "appealed";
      })
      .catch(function () {
        global.alert("申诉提交失败，请稍后再试，或直接发邮件到 blueprintstudio@yeah.net 人工申诉。");
        return "dismissed";
      });
  }

  /* ---------- 管理员接口 ---------- */
  function listAppeals(token) {
    return call("/api/appeal", null, token, "GET");
  }
  function resolveAppeal(token, id, outcome) {
    return call("/api/appeal", { action: "resolve", id: id, outcome: outcome }, token);
  }
  function listReports(token) {
    return call("/api/report", null, token, "GET");
  }
  function resolveReport(token, id, outcome) {
    return call("/api/report", { action: "resolve", id: id, outcome: outcome }, token);
  }

  global.BPMod = {
    check: check,
    appeal: appeal,
    report: report,
    blockDialog: blockDialog,
    listAppeals: listAppeals,
    resolveAppeal: resolveAppeal,
    listReports: listReports,
    resolveReport: resolveReport,
    kindName: function (k) { return KIND_NAME[k] || k || "内容"; },
  };
})(window);
