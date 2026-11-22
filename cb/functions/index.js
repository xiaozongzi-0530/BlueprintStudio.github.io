/* CloudBase 云函数入口（CommonJS，文件名固定 index.js）
   动态 import ESM 路由模块（docs.cloudbase.net 推荐的 index.js → entry.mjs 模式） */
exports.main = async (event, context) => {
  try {
    const mod = await import("./api/entry.mjs");
    return await (mod.default || mod.entry)(event, context);
  } catch (error) {
    console.error("云函数执行失败:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: false, msg: "服务器内部错误", err: String(error && error.message || error) }),
    };
  }
};
