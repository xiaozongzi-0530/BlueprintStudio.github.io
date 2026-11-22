/* CloudBase 云数据库数据导入脚本
   ------------------------------------------------------------
   把 netlify 备份灌进云数据库（users / meta / data 三个集合）。
   凭证从环境变量读，绝不写死在文件里：

     TCB_ENV=blueprintstudio-d5f6u80sab2de6b7 \
     TCB_SECRET_ID=xxxx \
     TCB_SECRET_KEY=xxxx \
     node cb/import-data.cjs

   在云函数控制台「终端」里运行时，可用 SYMBOL_CURRENT_ENV 免凭证：
     （见 README「方式B：云函数内导入」）
*/
const fs = require("fs");
const path = require("path");
const cloud = require("@cloudbase/node-sdk");

const ENV = process.env.TCB_ENV || "blueprintstudio-d5f6u80sab2de6b7";
const BACKUP = process.env.BACKUP_DIR || "/workspace/netlify-backup-2026-11-16";

// 优先用显式凭证；没有则用云函数运行时环境（SYMBOL_CURRENT_ENV）
const sid = process.env.TCB_SECRET_ID;
const skey = process.env.TCB_SECRET_KEY;
const initOpts = (sid && skey)
  ? { env: ENV, secretId: sid, secretKey: skey }
  : { env: cloud.SYMBOL_CURRENT_ENV };
const app = cloud.init(initOpts);
const db = app.database();

function load(rel) {
  const p = path.join(BACKUP, rel);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// wrap 成 _blobs.js 期望的文档结构：{ v, __bin:false, meta:null }
function doc(v) {
  return { v: typeof v === "string" ? v : JSON.stringify(v), __bin: false, meta: null };
}

async function ensureCollections() {
  const names = ["users", "meta", "data"];
  for (const n of names) {
    try {
      await db.createCollection(n);
      console.log("  + 集合已创建:", n);
    } catch (e) {
      // -501001 / 已存在 都视为 OK
      if (/exist|已存在|already/i.test(String(e && e.message || e))) {
        console.log("  = 集合已存在:", n);
      } else {
        console.log("  ! 集合创建跳过:", n, String(e && e.message || e));
      }
    }
  }
}

async function upsert(coll, id, value) {
  const ref = db.collection(coll).doc(String(id));
  let exists = false;
  try {
    const r = await ref.get();
    exists = !!(r && r.data && r.data.length);
  } catch (e) {}
  if (exists) await ref.update(doc(value));
  else await ref.set(doc(value));
  console.log(`  ✓ ${coll}::${id}`);
}

(async () => {
  console.log("目标环境:", ENV);
  console.log("备份目录:", BACKUP);
  console.log("凭证方式:", (sid && skey) ? "显式 SecretId/Key" : "SYMBOL_CURRENT_ENV(云函数运行时)");
  console.log("--- 建集合 ---");
  await ensureCollections();

  console.log("--- users::__all ---");
  await upsert("users", "__all", load("users/__all.json"));

  console.log("--- meta::__api_secret ---");
  const secret = fs.readFileSync(path.join(BACKUP, "meta/__api_secret.txt"), "utf8").trim();
  await upsert("meta", "__api_secret", secret);

  console.log("--- data 业务库(5) ---");
  const stores = [
    "blueprintstudio-chat-v2", "blueprintstudio-discover-v1",
    "blueprintstudio-forum-2026", "blueprintstudio-logs-v1", "blueprintstudio-notes-2026",
  ];
  for (const s of stores) {
    await upsert("data", s, load(`data/${s}.json`));
  }

  console.log("\n全部导入完成 ✓");
  process.exit(0);
})().catch((e) => {
  console.error("导入失败:", e);
  process.exit(1);
});
