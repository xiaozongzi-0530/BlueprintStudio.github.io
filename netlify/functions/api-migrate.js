/* /api/migrate —— 一次性数据迁移：textdb.dev → Blobs
   安全性：迁移的数据本来就是公开的（textdb 全公开），因此本接口无鉴权，
   但仅当目标 key 在 Blobs 中不存在时才执行导入（幂等，重复调用无害）。
   users-v2 导入后，会把 textdb 原库中的密码 hash 抹掉脱敏。
   GET /api/migrate 即执行，返回每个 key 的迁移结果 */
import { getStore } from "@netlify/blobs";
import { json, preflight, putUsersRaw, getUsersRaw } from "./_lib.js";

export const config = { path: "/api/migrate" };

const KEYS = [
  "blueprintstudio-users-v2",
  "blueprintstudio-announce-v2",
  "blueprintstudio-forum-2026",
  "blueprintstudio-notes-2026",
  "blueprintstudio-chat-v2",
  "blueprintstudio-discover-v1",
];

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "GET") return json({ ok: false, msg: "只支持 GET" }, 405);

  const data = getStore("data");
  const result = {};

  for (const key of KEYS) {
    try {
      const exists = await data.get(key);
      if (exists !== null) { result[key] = "skipped（已有数据）"; continue; }

      const r = await fetch("https://textdb.dev/api/data/" + key, { cache: "no-store" });
      if (!r.ok) { result[key] = "textdb 读取失败 HTTP " + r.status; continue; }
      const text = await r.text();
      if (!text || text === "null") { result[key] = "textdb 为空，跳过"; continue; }
      JSON.parse(text);   // 校验是合法 JSON

      if (key === "blueprintstudio-users-v2") {
        /* users：hash 迁入服务端，然后把 textdb 上的原库脱敏（删除 hash 字段） */
        await putUsersRaw(JSON.parse(text));
        const masked = JSON.parse(text);
        let removed = 0;
        Object.keys(masked.users || {}).forEach(e => {
          if (masked.users[e] && masked.users[e].hash) { delete masked.users[e].hash; removed++; }
        });
        await fetch("https://textdb.dev/api/data/" + key, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(masked),
        });
        result[key] = "导入完成，textdb 原库已脱敏 " + removed + " 个密码 hash";
      } else {
        await data.set(key, text);
        result[key] = "导入完成（" + text.length + " 字节）";
      }
    } catch (e) {
      result[key] = "失败：" + (e && e.message);
    }
  }

  return json({ ok: true, result });
};
