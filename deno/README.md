# BlueprintStudio 后端 · Deno Deploy 版

由 Cloudflare Workers 版平移而来，代码已在本地端到端测试通过（账号/登录/数据读写/AI 路由/审核降级）。

## 架构

- 静态页面继续用 GitHub Pages，不迁
- 后端 API 部署在 Deno Deploy，单入口 `worker.js`
- 数据存 Deno KV（已适配成原 Netlify Blobs 的 `getStore` 接口，业务代码零改动）
- 定时清理用 `Deno.cron()`，每天 UTC 03:00 删除超过 3 天的 AI 资产

## 部署步骤

### 1. 准备账号
- 注册 [console.deno.com](https://console.deno.com)，创建组织（org）

### 2. 创建 KV 数据库
```bash
deno deploy database provision bp-kv --kind denokv --org <你的组织>
deno deploy database assign bp-kv --app <你的应用> --org <你的组织>
```
> 注意：Deno Deploy 给每个 timeline 独立 KV，**生产环境的库要在 Production timeline 上 assign**。

### 3. 配置环境变量（Secrets）
在 dashboard 或 CLI 里设置（Production context）：
```
GLM_API_KEY       智谱 key（AI 写代码/生图/生视频/文件）
GLM_MODERATE_KEY  审核用 key（可用同一个，也可分开）
CLEAN_SECRET      定时清理校验串（随便一个强随机串）
```
> 环境变量名不能以 `DENO_` / `LD_` / `OTEL_` 开头。

### 4. 导入数据
本地装好 Deno 后：
```bash
# 先用 dashboard 的 KV 导出/导入工具，或改成连远程 KV
# 本地测试用：KV_PATH=./bp-kv deno task start
# 数据文件在 /workspace/netlify-backup-2026-11-16/
```
把以下数据写进 KV（key 格式见 `_seed.js`）：
- `["users","__all"]` ← `users/__all.json`
- `["meta","__api_secret"]` ← `meta/__api_secret.txt`
- `["data","blueprintstudio-xxx"]` ← `data/blueprintstudio-xxx.json`（5 个库）

### 5. 部署
```bash
cd deno
deno deploy --org <你的组织> --app <你的应用> --prod
```
部署后得到一个 `https://<app>.deno.net` 地址。

### 6. 前端切换
把所有页面里的
```js
var BASE = "https://blueprintstudio-mail.netlify.app";
```
改成
```js
var BASE = "https://<app>.deno.net";
```
（目前在 `ai-code.html`、`api.js` 等文件里。注意 AI 现在处于关闭状态，恢复时再改。）

## 本地运行

```bash
deno task start
# 默认端口 8000；会读 .env 环境变量
```
本地 KV 用文件模拟；部署到 Deno Deploy 时自动用托管 KV（不设 KV_PATH 即可）。
