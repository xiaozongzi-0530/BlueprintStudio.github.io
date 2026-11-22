# BlueprintStudio 后端 · 腾讯云 CloudBase 版

由 Netlify/CF 版平移而来，本地端到端测试 10 项全过（账号/登录/token/数据读写/CORS/AI 路由）。国内直连，微信扫码注册，不依赖 GitHub。

## 结构

```
cb/functions/
  index.js          # CJS 云函数入口（exports.main），动态 import ESM
  package.json      # 依赖 @cloudbase/node-sdk
  api/
    entry.mjs       # ESM 路由：event → Request → 各 API → Response → 结果
    api-*.js        # 10 个业务接口（未改动）
    _blobs.js       # 云数据库适配层（getStore）
    _lib.js/_glm.js/_aistore.js  工具
    package.json    # {"type":"module"}
```

静态页面继续用 GitHub Pages，不迁。

## 部署步骤（你操作的部分）

### 1. 创建云函数
- 进 CloudBase 控制台 → 云函数 → 新建
- 函数名：`api`
- 运行环境：Node.js 18（或更高）
- 方式：本地上传代码，把 `cb/functions/` 目录整个上传（含 index.js 和 api/ 子目录）
- 入口：`index.js` 的 `main`

### 2. 创建云数据库集合
在「数据库」里手动建这些集合（空集合即可，代码会自动写）：
- `users`
- `meta`
- `data`
- `ai-assets`
- `ai-files`

### 3. 配置环境变量（云函数 -> 配置 -> 环境变量）
```
GLM_API_KEY       智谱 key 或中转 key
GLM_MODERATE_KEY  审核 key
CLEAN_SECRET      清理校验串（强随机串）
```

### 4. 开启 HTTP 访问
- 云函数 → api → HTTP 访问服务 → 开启
- 路径配置：`/api/*` 映射到该函数（或每个接口单独配，推荐通配符）
- 拿到公网地址，形如 `https://xxx.service.tcloudbase.com/api/`

### 5. 导入数据
把备份数据写进云数据库对应集合：
- `users` 集合：一条文档 `_id=__all`，内容为 `users/__all.json` 的对象（外层包一层 `{v: 内容JSON字符串, __bin:false, meta:null}`）
- `meta` 集合：`_id=__api_secret`，`{v:"密钥字符串", __bin:false, meta:null}`
- `data` 集合：5 条文档，`_id` 分别为 `blueprintstudio-xxx`，`{v: 该库JSON字符串, __bin:false, meta:null}`

> 具体导入脚本我在拿到环境 ID 后提供（用 @cloudbase/node-sdk 一键写入）。

### 6. 前端切换 + 撤维护页
把前端接口地址改成 CloudBase 的 HTTP 地址，然后撤掉全站维护跳转。这步我来做。

## 定时清理
清理接口 `/api/aiclean` 保留。可在云函数控制台配定时触发器（每天一次）带 header `x-clean-secret`，或管理员带 token 手动触发。
