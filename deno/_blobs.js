/* Deno KV 适配层 —— 模拟 Netlify Blobs 的 getStore API
   ------------------------------------------------------------
   与 Cloudflare 版 API 完全一致，函数无需改动即可运行。
   Deno KV 用数组 key：[storeName, key]，值与元数据一起存进 record。
   用 setKV(kv) 注入 Deno.openKv() 实例。
*/
let _kv = null;
export function setKV(kv) { _kv = kv; }
export function getKV() { return _kv; }

/* 包一层，带上二进制标记与 metadata（Deno KV 无独立 metadata 字段） */
function wrap(value, opts) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { v: btoa(bin), __bin: true, meta: (opts && opts.metadata) || null };
  }
  return { v: String(value), __bin: false, meta: (opts && opts.metadata) || null };
}

function unwrap(rec, type) {
  if (!rec) return null;
  if (rec.__bin) {
    const bin = atob(rec.v);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (type === "arrayBuffer") return bytes.buffer;
    return bytes.buffer;
  }
  return rec.v;
}

export function getStore(storeName) {
  if (!_kv) throw new Error("KV 未初始化");
  const k = (key) => [storeName, String(key)];
  return {
    async get(key, opts) {
      const r = await _kv.get(k(key));
      return unwrap(r && r.value, opts && opts.type);
    },
    async getWithMetadata(key) {
      const r = await _kv.get(k(key));
      if (!r || !r.value) return { value: null, metadata: null };
      return { value: unwrap(r.value), metadata: r.value.meta || null };
    },
    async getMetadata(key) {
      const r = await _kv.get(k(key));
      return { metadata: (r && r.value && r.value.meta) || null };
    },
    async set(key, value, opts) {
      await _kv.set(k(key), wrap(value, opts));
    },
    async delete(key) {
      await _kv.delete(k(key));
    },
    list(options) {   /* 返回 async generator，不能是 async（否则 for await 遍历到 Promise） */
      options = options || {};
      const iter = _kv.list({ prefix: [storeName] });
      async function* gen() {
        let n = 0;
        for await (const entry of iter) {
          if (options.limit && n >= options.limit) break;
          // Deno KV key 是 [storeName, key]，取第二段
          yield { key: String(entry.key[1]) };
          n++;
        }
      }
      return gen();
    },
  };
}
