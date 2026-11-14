/* /api/file —— 附件服务（替代把 base64 塞进 JSON 的旧方案）
   POST multipart/form-data: file=<二进制>
        单文件 ≤ 5MB；登录用户 60 次/小时，游客（无 token）20 次/小时
        返回 {ok, id, size}
   GET  ?id=xxx   公开下载（附件在帖子/笔记里本来就是公开展示的），
        响应带不可变缓存头，内容寻址：id 唯一、内容永不变 */
import { getStore } from "@netlify/blobs";
import { json, preflight, clientIP, rateLimit, verifyToken } from "./_lib.js";

export const config = { path: "/api/file" };

const store = () => getStore("files");
const MAX = 5 * 1024 * 1024;   // 5MB

export default async (req) => {
  if (req.method === "OPTIONS") return preflight();

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("id") || "";
    if (!/^[a-f0-9]{24}$/.test(id)) return json({ ok: false, msg: "id 不合法" }, 400);
    const buf = await store().get(id, { type: "arrayBuffer" });
    if (!buf) return json({ ok: false, msg: "附件不存在或已删除" }, 404);
    const meta = await store().getWithMetadata(id);
    const type = (meta && meta.metadata && meta.metadata.type) || "application/octet-stream";
    const name = (meta && meta.metadata && meta.metadata.name) || "attachment";
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": type,
        "Content-Disposition": 'inline; filename*=UTF-8\'\'' + encodeURIComponent(name),
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (req.method !== "POST") return json({ ok: false, msg: "只支持 GET/POST" }, 405);

  const ip = clientIP(req);
  const tok = await verifyToken(req);
  const limit = tok ? 60 : 20;
  if (!rateLimit(tok ? "fu" : "fg", ip, limit, 3600 * 1000)) {
    return json({ ok: false, msg: "上传太频繁（每小时 " + limit + " 次），请稍后再试" }, 429);
  }

  let form;
  try { form = await req.formData(); } catch (e) { return json({ ok: false, msg: "需要 multipart/form-data" }, 400); }
  const file = form.get("file");
  if (!file || typeof file === "string") return json({ ok: false, msg: "缺少 file 字段" }, 400);
  if (file.size > MAX) return json({ ok: false, msg: "文件超过 5MB 上限" }, 413);
  if (file.size === 0) return json({ ok: false, msg: "空文件" }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const rnd = new Uint8Array(12);
  crypto.getRandomValues(rnd);
  const id = Array.from(rnd).map(x => x.toString(16).padStart(2, "0")).join("");

  await store().set(id, bytes, {
    metadata: {
      name: String(file.name || "attachment").slice(0, 120),
      type: String(file.type || "application/octet-stream").slice(0, 100),
      size: file.size,
      by: (tok && tok.email) || ("ip:" + ip),
      at: new Date().toISOString(),
    },
  });
  return json({ ok: true, id: id, size: file.size, name: file.name });
};
