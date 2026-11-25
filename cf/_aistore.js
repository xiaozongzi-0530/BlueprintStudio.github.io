/* AI 资产共享库（以 _ 开头，不部署为独立函数）
   ------------------------------------------------------------
   负责：生成资产的元数据记录、远程文件转存到自有 Blobs、下载读取、过期清理。
   设计要点：
   - 智谱返回的图片/视频 URL 有 30 天有效期，但我们只承诺 3 天下载：
     生成成功后把文件转存到自有私有 Blobs，下载只走自己的接口，到期即删。
   - 资产按登录用户 uid 隔离；下载接口校验 token + 归属。
   - 元数据存 assets store，二进制存 files store，二者 key 一致（asset id）。
*/
import { getStore } from "./_blobs.js";

export const ASSET_TTL = 3 * 24 * 3600 * 1000;   // 3 天
const metaStore = () => getStore("ai-assets");
const fileStore = () => getStore("ai-files");

/* 生成资产 id：时间戳 + 随机串 */
export function newAssetId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

/* ---------- 元数据 ---------- */
export async function putAsset(asset) {
  await metaStore().set(asset.id, JSON.stringify(asset));
}
export async function getAsset(id) {
  if (!/^[a-z0-9-]{6,40}$/i.test(String(id || ""))) return null;
  const raw = await metaStore().get(id);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
export async function delAsset(id) {
  await metaStore().delete(id);
  try { await fileStore().delete(id); } catch (e) {}
}

/* 列出某用户的资产（不取二进制，只取元数据），按创建时间倒序 */
export async function listAssets(uid, limit) {
  const out = [];
  for await (const b of metaStore().list({ paginate: true })) {
    const a = await getAsset(b.key);
    if (a && a.uid === uid) out.push(a);
    if (out.length >= (limit || 60) * 4) break;   // 防止极端情况全表扫描
  }
  out.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  return out.slice(0, limit || 60);
}

/* ---------- 二进制转存 ---------- */
/* 把远程 URL 下载下来存进自有 Blobs。返回 {ok, contentType, size} */
export async function stashRemote(asset, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 50000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("下载远程文件失败 HTTP " + r.status);
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 95 * 1024 * 1024) throw new Error("文件超过 95MB 上限");
    let ct = r.headers.get("content-type") || "";
    // 智谱图片常"声称 image/png 实际返回 JPEG"，且偶发 octet-stream：按文件头 sniff 真实格式
    const u8 = new Uint8Array(buf);
    const jpeg = u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff;
    const png = u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47;
    const webp = String.fromCharCode.apply(null, u8.subarray(0, 4)) === "RIFF"
      && String.fromCharCode.apply(null, u8.subarray(8, 12)) === "WEBP";
    if (asset.type === "image") {
      ct = jpeg ? "image/jpeg" : png ? "image/png" : webp ? "image/webp" : "image/png";
    } else if (asset.type === "video") {
      if (!ct || ct.indexOf("octet-stream") !== -1) ct = "video/mp4";
    } else if (!ct || ct.indexOf("octet-stream") !== -1) {
      ct = "application/octet-stream";
    }
    await fileStore().set(asset.id, buf, { metadata: { contentType: ct } });
    asset.stored = true;
    asset.contentType = ct;
    asset.size = buf.byteLength;
    asset.status = "ready";
    await putAsset(asset);
    return { ok: true, contentType: ct, size: buf.byteLength };
  } finally {
    clearTimeout(timer);
  }
}

/* 读取已转存的文件，返回 {body(ArrayBuffer), contentType, ext, name} */
export async function readFile(asset) {
  const raw = await fileStore().get(asset.id, { type: "arrayBuffer" });
  if (!raw) return null;
  const meta = await fileStore().getMetadata(asset.id).catch(() => null);
  const md = (meta && meta.metadata) || {};
  let contentType = md.contentType || asset.contentType || "application/octet-stream";
  let ext = asset.ext || "";   // file 类型生成时已指定 md/txt
  if (!ext || ext === "bin") {
    ext = "bin";
    if (/image\/png/i.test(contentType)) ext = "png";
    else if (/image\/jpeg/i.test(contentType)) ext = "jpg";
    else if (/image\/webp/i.test(contentType)) ext = "webp";
    else if (/image\//i.test(contentType)) ext = "png";
    else if (/video\/mp4/i.test(contentType)) ext = "mp4";
    else if (/video\//i.test(contentType)) ext = "mp4";
    else if (/markdown/i.test(contentType)) ext = "md";
    else if (/text\/|\+json|json/i.test(contentType)) ext = "txt";
  }
  const safePrompt = String(asset.prompt || "ai").replace(/[^\w\u4e00-\u9fa5-]+/g, "_").slice(0, 24) || "ai";
  const name = (asset.type || "file") + "-" + safePrompt + "." + ext;
  return { body: raw, contentType, ext, name };
}

/* ---------- 过期清理（供定时函数调用）---------- */
export async function cleanExpired(now) {
  now = now || Date.now();
  let removed = 0, scanned = 0;
  for await (const b of metaStore().list({ paginate: true })) {
    scanned++;
    const a = await getAsset(b.key);
    if (!a) continue;
    if (now - (a.createdAt || 0) > ASSET_TTL || a.expired) {
      await delAsset(b.key);
      removed++;
    }
  }
  return { scanned, removed };
}
