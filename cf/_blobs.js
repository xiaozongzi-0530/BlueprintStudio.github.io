/* Cloudflare KV 适配层 —— 模拟 Netlify Blobs 的 getStore API
   ------------------------------------------------------------
   让现有后端函数无需改逻辑即可在 CF Workers 上运行。
   每个 store 映射为 KV 中的一个 key 前缀： `<store>::<key>`
   getStore 需要一个 env.KV 绑定，通过 setKV(env.KV) 注入。
*/
let _kv = null;
export function setKV(kv) { _kv = kv; }

function k(store, key) { return store + "::" + key; }

/* 把 ArrayBuffer / Uint8Array 转成可存 KV 的 base64 字符串，并记录标记 */
function encodeValue(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { v: btoa(bin), __bin: true };
  }
  return { v: String(value), __bin: false };
}

function decodeValue(rec, type) {
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
  const prefix = storeName + "::";
  return {
    async get(key, opts) {
      const rec = await _kv.get(k(storeName, key), "json");
      return decodeValue(rec, opts && opts.type);
    },
    async getWithMetadata(key) {
      return await _kv.getWithMetadata(k(storeName, key), "json");
    },
    async getMetadata(key) {
      const r = await _kv.getWithMetadata(k(storeName, key), "json");
      return { metadata: (r && r.metadata) || null };
    },
    async set(key, value, opts) {
      const rec = encodeValue(value);
      const putOpts = {};
      if (opts && opts.metadata) putOpts.metadata = opts.metadata;
      await _kv.put(k(storeName, key), JSON.stringify(rec), putOpts);
    },
    async delete(key) {
      await _kv.delete(k(storeName, key));
    },
    async list(options) {
      options = options || {};
      // 同步返回可 for-await 的异步迭代器，兼容 Netlify 的 paginate 用法
      const self = this;
      const prefixLocal = prefix;
      async function* gen() {
        let cursor = null;
        do {
          const page = await _kv.list({ prefix: prefixLocal, cursor: cursor || undefined, limit: 1000 });
          for (const item of page.keys || []) {
            yield { key: item.name.slice(prefixLocal.length) };
          }
          cursor = page.list_complete ? null : page.cursor;
        } while (cursor && !options.limit);
      }
      return gen();
    },
  };
}
