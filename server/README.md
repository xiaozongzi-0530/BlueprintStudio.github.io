# 邮箱验证码服务（Cloudflare Worker）

给网站注册流程加上「邮箱验证码」的服务端。因为 GitHub Pages 是纯静态托管，页面本身发不出邮件、也存不住验证码，所以需要这一小块服务。

发信直接走 `smtp.yeah.net:465`，用你已有的网易邮箱授权码，**不需要再注册任何第三方邮件服务**。

---

## 一、部署前准备

1. 一个 Cloudflare 账号（<https://dash.cloudflare.com/sign-up>，邮箱注册即可，不需要信用卡）
2. `blueprintstudio@yeah.net` 的 **SMTP 授权码**
   - 登录 <https://mail.yeah.net> → 设置 → POP3/SMTP/IMAP → 开启 SMTP → 新增授权密码
   - 是 16 位字符，**不是**邮箱登录密码

---

## 二、部署（约 5 分钟）

### 1. 创建 Worker

Cloudflare 后台 → 左侧 **Workers & Pages** → **Create** → **Create Worker** → 名字填 `bs-verify` → **Deploy**

### 2. 粘代码

点 **Edit code**，把 `worker.js` 全文粘进去覆盖编辑器里的默认内容 → 右上角 **Deploy**

### 3. 建 KV 命名空间

左侧 **Workers & Pages** → **KV** → **Create a namespace** → 名字填 `bs-codes` → **Create**

### 4. 绑定 KV 到 Worker

回到 `bs-verify` 这个 Worker → **Settings** → **Bindings** → **Add** → 选 **KV Namespace**

- Variable name：`CODES`（必须一字不差，大写）
- KV namespace：选刚才建的 `bs-codes`

保存。

### 5. 添加环境变量

同一个 **Settings** 页面 → **Variables and Secrets** → **Add**，加两条：

| 类型 | Name | Value |
|---|---|---|
| Secret | `SMTP_USER` | `blueprintstudio@yeah.net` |
| Secret | `SMTP_PASS` | 你的 16 位 SMTP 授权码 |

> 类型一定选 **Secret**，这样值存进去之后在后台就再也读不出来了。

### 6. 复制地址

Worker 页面上会显示形如：

```
https://bs-verify.你的子域.workers.dev
```

打开这个地址，会看到一个状态页，用来确认部署是否完整：

```json
{
  "ok": true,
  "service": "BlueprintStudio 邮箱验证码服务",
  "status": "running",
  "kv": "已绑定 CODES",
  "smtp": "已配置 SMTP_USER / SMTP_PASS",
  "endpoints": ["POST /send-code", "POST /verify-code"]
}
```

`kv` 和 `smtp` 两行会告诉你还差什么。如果显示「未绑定 CODES」或「未配置 SMTP_USER…」，回到第 4、5 步检查。

> 注意：在浏览器里直接打开时看到 `forbidden_origin` 说明你拿到的是没有状态页的旧版本代码，重新粘贴一次即可。这个错误本身不代表服务坏了 —— 它是因为代码拦截了所有非白名单来源的请求，而浏览器直接访问时不发 `Origin` 头。

把这个地址发给我，我填进 `index.html` 的 `MAIL_API`，验证码功能就生效了。

---

## 三、自测

部署完先自己试一次，确认发信通：

```bash
curl -X POST https://bs-verify.你的子域.workers.dev/send-code \
  -H "Content-Type: application/json" \
  -H "Origin: https://xiaozongzi-0530.github.io" \
  -d '{"email":"你的邮箱@example.com"}'
```

收到 `{"ok":true,...}` 且邮箱里 1 分钟内收到验证码，就说明整条链路都通了。

如果返回 `smtp_failed`，看 `message` 里的阶段名：

| 阶段 | 含义 |
|---|---|
| 连接 | 连不上 smtp.yeah.net，检查网络 |
| 握手 | TLS 协商失败 |
| 认证 | 授权码错了，或者用了登录密码而不是授权码 |
| 设置收件人 | 对方邮箱被网易拒收 |
| 发送正文 | 邮件内容被判定为垃圾邮件 |

---

## 四、接口说明

### `POST /send-code`

```json
{ "email": "user@example.com" }
```

成功：`{"ok":true,"ttl":600,"message":"验证码已发送"}`

一个 6 位数字验证码会发到该邮箱，**有效期 10 分钟**。

### `POST /verify-code`

```json
{ "email": "user@example.com", "code": "374296" }
```

成功：`{"ok":true}`。验证通过后该验证码立即作废，不能二次使用。

失败时 `error` 取值：

| error | 含义 |
|---|---|
| `invalid_email` | 邮箱格式不对 |
| `invalid_code` | 不是 6 位数字 |
| `code_expired` | 过期或已用掉 |
| `code_mismatch` | 填错了，`message` 里带剩余次数 |
| `too_many_attempts` | 错满 5 次，验证码作废 |
| `cooldown` | 同一邮箱 60 秒内重复请求 |
| `rate_limited` | 同一 IP 每小时超过 5 次 |
| `quota_exceeded` | 全局当日 150 封额度用完 |
| `smtp_failed` | 网易那边发信失败 |

---

## 五、这套防护挡的是什么

| 措施 | 作用 |
|---|---|
| 单 IP 每小时 5 次 | 防止有人写脚本狂刷，把你的网易账号发信额度打爆 |
| 全局每日 150 封 | 兜底，最坏情况也只发这么多 |
| 同邮箱 60 秒冷却 | 防连点 |
| 验证码 5 次试错上限 | 防止穷举 6 位数字 |
| 验证码一次性 | 用过即废 |
| 只存 HMAC 摘要 | 就算 KV 数据被人看到，也反推不出验证码 |
| 来源白名单 | 只接受你自己站点的请求 |

---

## 六、维护

- **免费额度**：Worker 每天 10 万次请求，KV 每天 10 万次读 / 1000 次写 / 1GB 存储。正常使用远远用不完。
- **换授权码**：网易后台重新生成后，去 Worker 的 Variables and Secrets 里改 `SMTP_PASS` 的值即可，代码不用动。
- **看日志**：Worker 页面 → **Logs** → Begin log stream，能看到每次请求的实时日志。

---

## 七、已知边界

1. **这不是防 DDoS 的方案。** 它只保护「发信」这一个动作不被滥用。真正的流量攻击要在 Cloudflare 的 Security → WAF 里配 Rate limiting 规则，那是另一层。
2. **Cloudflare 封了 25 端口**，所以只能用 465（隐式 TLS）。如果以后换成只支持 25 端口的邮件服务，这套代码就跑不动了。
3. **验证码只存在 KV**，KV 是最终一致的，但在同一区域内的读写延迟通常在几十毫秒内，实测没有出现过「刚发就查不到」的情况。
