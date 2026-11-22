/* 测试数据导入脚本：把 netlify 备份灌进本地 Deno KV（仅本地测试用） */
import { getStore, setKV } from "./_blobs.js";

const KV_PATH = Deno.env.get("KV_PATH") || ".deno-kv-test";
const kv = await Deno.openKv(KV_PATH);
setKV(kv);

const BK = "/workspace/netlify-backup-2026-11-16";
async function load(path) {
  try { return JSON.parse(await Deno.readTextFile(path)); }
  catch (e) { console.error("读取失败", path, String(e)); return null; }
}

/* users::__all —— 完整账号（含 hash）。用 getStore.set 走标准 wrap */
const users = await load(`${BK}/users/__all.json`);
if (users) { await getStore("users").set("__all", JSON.stringify(users)); console.log("✓ users::__all"); }

/* meta::__api_secret —— 签名密钥（字符串直存，wrap 成 {v,__bin:false}） */
try {
  const secret = (await Deno.readTextFile(`${BK}/meta/__api_secret.txt`)).trim();
  await getStore("meta").set("__api_secret", secret);
  console.log("✓ meta::__api_secret");
} catch (e) { console.error("密钥读取失败", String(e)); }

/* 5 个业务库，整体存 __all */
const stores = [
  "blueprintstudio-chat-v2", "blueprintstudio-discover-v1",
  "blueprintstudio-forum-2026", "blueprintstudio-logs-v1", "blueprintstudio-notes-2026",
];
for (const s of stores) {
  const data = await load(`${BK}/data/${s}.json`);
  // api-data 用 getStore("data").get(key)，key 即 blueprintstudio-xxx
  if (data) { await getStore("data").set(s, JSON.stringify(data)); console.log(`✓ data::${s}`); }
}

await kv.close();
console.log("导入完成，KV 路径:", KV_PATH);
