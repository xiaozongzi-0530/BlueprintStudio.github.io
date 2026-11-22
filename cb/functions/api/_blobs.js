/* CloudBase 云数据库适配层 —— 模拟 Netlify Blobs 的 getStore API
   ------------------------------------------------------------
   每个 store 映射为一个云数据库集合(collection)，每条记录是一个文档。
   文档结构：{ _id: key, v: 值字符串, __bin: 是否二进制, meta: 元数据 }
   用 initDB() 注入 @cloudbase/node-sdk 的 database 实例。
*/
import cloud from "@cloudbase/node-sdk";

let _db = null;
export function initDB() {
  if (_db) return _db;
  const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
  _db = app.database();
  return _db;
}
/* 供入口在无环境变量时测试注入 */
export function setDB(db) { _db = db; }

function coll(storeName) {
  if (!_db) initDB();
  return _db.collection(storeName);
}
/* 云集合名只允许字母数字下划线横线；store 名都符合 */

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
  return {
    async get(key, opts) {
      const r = await coll(storeName).doc(String(key)).get();
      const doc = r && r.data && r.data[0];
      return unwrap(doc, opts && opts.type);
    },
    async getWithMetadata(key) {
      const r = await coll(storeName).doc(String(key)).get();
      const doc = r && r.data && r.data[0];
      if (!doc) return { value: null, metadata: null };
      return { value: unwrap(doc), metadata: doc.meta || null };
    },
    async getMetadata(key) {
      const r = await coll(storeName).doc(String(key)).get();
      const doc = r && r.data && r.data[0];
      return { metadata: (doc && doc.meta) || null };
    },
    async set(key, value, opts) {
      const data = wrap(value, opts);
      // set 不存在则创建；云函数 set 会覆盖整条文档
      await coll(storeName).doc(String(key)).set({ ...data });
    },
    async delete(key) {
      await coll(storeName).doc(String(key)).remove();
    },
    async list(options) {
      options = options || {};
      async function* gen() {
        // 云数据库单次最多 100 条；简单分页用 skip
        let skip = 0;
        const batch = 100;
        let n = 0;
        while (true) {
          const r = await coll(storeName).skip(skip).limit(batch).get();
          const arr = (r && r.data) || [];
          if (!arr.length) break;
          for (const d of arr) {
            if (options.limit && n >= options.limit) return;
            yield { key: String(d._id) };
            n++;
          }
          if (arr.length < batch) break;
          skip += batch;
        }
      }
      return gen();
    },
  };
}
