/* 写代码 GLM key 池：多把 key 自动分配 + 失败切换
   ------------------------------------------------------------
   环境变量（任选其一/组合）：
     GLM_API_KEY_1 / GLM_API_KEY_2 / GLM_API_KEY_3 ...  （逐把配置）
     GLM_API_KEYS       （逗号分隔，等价写法）
     GLM_API_KEY        （单把兜底，兼容旧配置）
   读取后去重、每次请求随机洗牌（分散负载 = “哪把空闲用哪把”），
   调用方按返回顺序逐个尝试，某把限流/报错自动切下一把。
   注意：审核用独立的 GLM_MODERATE_KEY，不进这个池。 */

/* 读取池中全部可用 key（去重、去空），至少返回 1 把或空数组 */
export function getPool() {
  const out = [];
  for (let i = 1; i <= 20; i++) {
    const k = process.env["GLM_API_KEY_" + i];
    if (k && k.trim()) out.push(k.trim());
  }
  const csv = process.env.GLM_API_KEYS;
  if (csv) for (const k of String(csv).split(/[,;，；\s]+/)) if (k.trim()) out.push(k.trim());
  const single = process.env.GLM_API_KEY;
  if (single && single.trim()) out.push(single.trim());
  return Array.from(new Set(out));
}

/* Fisher-Yates 洗牌：返回新数组，不改动入参 */
export function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* 判断某次 GLM 错误是否值得换 key 重试（限流/过载/服务端错误/网络） */
export function shouldSwitch(err) {
  const m = String(err && err.message || err || "");
  return /429|1305|503|502|500|504|timeout|abort|network|fetch failed|ECONN|ETIMEDOUT/i.test(m);
}
