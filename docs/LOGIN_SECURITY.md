# 登录安全升级与上线操作

保留第五页「実装案①」的 Express、SimpleWebAuthn、本地签名验证和安全 Cookie。根据最新 Demo 需求，注册准入已从人工邀请调整为公司邮箱自助验证：员工输入邮箱用户名，固定后缀为 `@abist.co.jp`，收取验证码后创建 Passkey。不要求业务管理员逐个邀请，但平台和邮件服务仍需要一位部署维护者管理配置。

新账号验证后加入同一个默认工作区，角色为 `designer`。用户可在设置中经 Passkey 再次验证后切换 `designer` / `it`。IT 可以查看、投稿、修改自己的资料，但不能审批、差戻し、拒绝，也不能作为审批人；切为 IT 时，涉及其担任审批人的待审批卡片会差回投稿者并清除该轮投票。既有 `senior` / `viewer` 不允许通过此接口自行升级权限。シニア审批规则不变，需由部署维护者预先确定合适的 senior 成员，不能让所有用户自行提升。别名不会自动合并为同一账号。

## 立即在本机体验

需要 Node.js 22+、支持 Passkey 的浏览器和设备锁屏验证（Touch ID、Windows Hello、手机等）。

```sh
npm ci
npm run dev:passkey
```

命令显示两个地址：员工自助注册网页和 LOCAL TEST MAILBOX 模拟收件箱。用独立 Safari/Chrome 打开网页，点击「会社メールで新規登録」，只输入用户名和显示名；发送后刷新模拟收件箱查看8位验证码。输入验证码后创建 Passkey，再测试退出和登录。VS Code 内置浏览器可能无法完成原生验证，请用系统浏览器。此命令不会真实发信，不读取真实 Supabase；停止后测试数据消失，不能部署到公网。

可指定建议使用的测试邮箱，但网页不会据此绕过验证：

```sh
npm run dev:passkey -- --email employee@abist.co.jp
```

Mac 可用 `open -a Safari '网页地址' '模拟收件箱地址'`。手机尚无钥匙时，直接扫码“登录”不会创建钥匙，需先完成注册。localhost 只代表本机，不能发给远程同事。`npm run dev` 是旧密码业务演示，不是邮箱注册预览；公网使用 `npm start`，绝不能运行 `dev:passkey` 或暴露模拟收件箱。

## 零付费部署范围

使用一个 Render Free Web Service 提供同源 frontend + API，Supabase Free 存储业务与认证数据，SMTP2GO Free 发送确认邮件；使用平台 HTTPS 域名，不需购买网站域名。现有支持 Passkey 的设备即可使用，不要求另购硬件钥匙。

- SMTP2GO 官方 Free 额度为每月1,000封、每天200封，不允许额外邮件；必须确认账户选择 $0 Free 而非付费试用。应用另有限额保护，但服务商额度和共用账号总量仍需查看后台。
- 真实发送仍需要注册发信服务账号、验证发件人、配置服务器 API Key。不能未经授权冒用 `@abist.co.jp` 作为 From。若后台要求发件域名 DNS 或公司邮件策略许可，需得到相关人员配合，不能保证仅验证单个邮箱就一定能送达 Outlook。

- Render 空闲 15 分钟后休眠，首次唤醒约需 1 分钟；免费实例时数、流量和构建额度有限。
- Supabase Free 数据库有容量和流量限制，连续约一周不活跃可能暂停，需管理员恢复。
- 选择 Free 计划，不添加付费附加项；检查账户是否已有付款方式和超额计费。Render 无付款方式时超额通常停止服务/构建，而不是自动付费。不规避供应商额度限制。
- 这是免费额度内的公网小规模试运行，不承诺持续在线、SLA、无限流量或商业关键系统级保障。Render 官方不建议将 Free 用于正式生产应用；若业务要求高可用，零费用与该要求不相容。
- 服务政策可能变化，上线前复核 [Render Free](https://render.com/docs/free)、[Supabase 定价](https://supabase.com/pricing)、[SMTP2GO 定价](https://www.smtp2go.com/pricing/)。

## 公网配置清单

下表均填写在现有 Render Web Service 的 Environment 页面，而不是聊天、GitHub 或 Vercel 前端变量。

| 变量 | 值或来源 |
| --- | --- |
| `DEMO_MODE` | `false` |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | Node 22，模板使用 `22.16.0` |
| `AUTH_ORIGIN` | 当前 Render 固定 HTTPS URL，末尾不加 `/`，不是 Dashboard 地址 |
| `SUPABASE_URL` | Supabase 项目 Connect 中的 Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 本项目沿用的变量名；填服务器专用 Secret Key 或已有 legacy service-role key，不能填 anon/publishable key |
| `MAIL_FROM` | SMTP2GO 后台验证通过的发件地址，只填邮箱地址，不加显示名 |
| `SMTP2GO_API_KEY` | SMTP2GO 后台创建的发信 API Key，服务器专用 |
| `EMAIL_CODE_SECRET` | 至少32字符的独立随机密钥，保持稳定，不在每次启动时重新生成 |
| `VITE_API_URL` | 删除旧跨域值，保持未设置或空；构建命令也强制为空 |

`WEBAUTHN_RP_ID` 可删除，由应用从 `AUTH_ORIGIN` 自动取得 hostname；如设置则必须精确相同且不含协议/端口。`PORT` 使用 Render 分配的值，不复制本机3001。移除 `AUTH_TEST_MAIL_URL`，不要把任何 loopback URL 或 `NODE_ENV=test` 带到公网。Supabase、邮件密钥都不加 `VITE_` 前缀，也不需要 Outlook 邮箱密码。

仓库的 [render.yaml](../render.yaml) 已包含邮件变量，Blueprint 新建时可生成 `EMAIL_CODE_SECRET`。但对现有 Blueprint，`sync: false` 新增变量不会自动注入，必须手工添加；使用普通已有 Web Service 也要手工设置。不要因为仓库模板已改就认为线上配置已完成。

## 数据库迁移与配置

1. 维护窗口内暂停旧 API；备份现有数据库，核对用户邮箱、项目成员与权限，删除不应保留的测试成员。
2. 在 Supabase SQL Editor 执行完整的 [schema.sql](../supabase/schema.sql)。可重复执行，不删除现有业务数据、用户 ID 或成员角色；新增认证表、权限和事务函数。
3. 按配置清单在 Render Environment 中填入变量；如需本机运行初始化命令，在仅自己控制的本机 `.env` 中保存服务器凭据，禁止提交 Git 或放入聊天：

```dotenv
DEMO_MODE=false
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_KEY
AUTH_ORIGIN=https://YOUR_SERVICE.onrender.com
NODE_ENV=production
VITE_API_URL=
MAIL_FROM=YOUR_VERIFIED_SENDER_EMAIL
SMTP2GO_API_KEY=YOUR_SERVER_ONLY_MAIL_KEY
EMAIL_CODE_SECRET=YOUR_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
```

`AUTH_ORIGIN` 必须与浏览器访问地址完全一致，不含路径和末尾 `/`。`WEBAUTHN_RP_ID` 可省略，默认为该 hostname；如果设置，只填 hostname，不能填协议或端口。应用拒绝任意不同的 RP ID。生产环境必须 HTTPS；仅开发环境 localhost/127.0.0.1 允许 HTTP。

4. 在配置了真实 Supabase 的本机执行 `npm run auth:init` 创建空工作区；已有资料不会被覆盖，也不会创建已知测试账号。不要在正式库运行 `seed:demo`。本地模拟预览的数据不会自动迁移到真实 Supabase。
5. 在 Render 选择 Free Web Service，使用仓库的 [render.yaml](../render.yaml)。Build Command 设置为 `npm ci --include=dev && VITE_API_URL= npm run build`，Start Command 为 `npm start`，健康检查 `/api/health`。构建阶段必须显式安装包含 Vite 的开发依赖，否则 `NODE_ENV=production` 下会报 `vite: not found`；运行时仍保持 `NODE_ENV=production` 和 `DEMO_MODE=false`。已有普通 Web Service 需在 Settings 中手工同步 Build Command，仓库 YAML 不会自动覆盖其配置。
6. 使用 Render URL 同时访问网页和 API，不再采用旧的 Vercel → Render 跨域直连。Render Free 没有 Shell/一次性任务，管理员命令在本机运行即可。

7. 所有代码、依赖锁文件、SQL 和模板需先提交并推送到 Render 实际关联的 GitHub 分支。已有服务先检查自动部署设置，避免未完成数据库迁移就触发部署。`npm test`、`npm run test:browser` 通过后，再明确选择最新提交进行部署。不会自动帮你提交、推送或执行真实数据库迁移。

服务启动时检查认证数据库是否可读。检查 `/api/config` 返回 `authMode: "passkey"`，`/api/health` 返回 `mode: "supabase"`；这两个公共接口不返回账户信息。不要把演示模式部署为正式系统。

## 员工自助注册

员工访问正式 Render HTTPS 地址，点击「会社メールで新規登録」，输入工号或姓名用户名及显示名。后缀固定 `@abist.co.jp`；拼错、子域名或外部域名由服务端再次拒绝。系统自动发8位验证码到完整公司邮箱。

验证码10分钟有效，最多尝试5次；重新发送需等待60秒，应用还有限制每个邮箱和总发信量。代码以带服务器密钥的 HMAC 保存，响应不返回验证码，验证绑定发起注册的浏览器会话。发信失败、配置缺失或额度耗尽均拒绝继续，不能用页面显示的调试码代替真实邮箱验证。

邮箱验证后点击「パスキーを登録」，在设备上完成验证。首次注册授权5分钟有效，不能跨浏览器移交；已有账号的 Passkey 不会因他人再次输入邮箱而被覆盖。已注册者使用 Passkey 登录，不输入邮箱密码。

邮箱归属验证不等于 HR 员工状态验证：本 Demo 没有公司目录同步、别名合并或自动离职撤权。按当前要求，任何能完成该公司邮箱验证的账号都会获得默认工作区 designer 权限，因此同事能查看同一工作区资料。只放组织允许的架空 Demo 数据。

旧邀请命令仍保留用于迁移和特殊运维，不是同事日常注册入口。历史用户不自动删除；已有权限不被自助注册覆盖。旧个人邮箱测试账号需在公开前清理；别名与工号邮箱不可不经核验就当成同一身份。

## 备用钥匙与恢复

登录后进入「管理・セキュリティ」，登记不同设备或独立凭据提供方的备用 Passkey。仅把同一把已同步的钥匙换个名称，不等于独立备份。每人最多 10 把钥匙；不能删除最后一把。

新增/删除钥匙要求最近 5 分钟完成过本人验证，超时可用「本人確認」重新验证。撤销钥匙时，同时退出该用户其他登录会话。Passkey 可同步，设备的生物识别/PIN 由认证器处理，服务器不接收指纹、PIN 或私钥。

全部钥匙丢失时，由管理员重新进行独立身份核验，再运行：

```sh
npm run auth:recover -- --email person@abist.co.jp --verified-by "AdminName: verified through known company contact"
```

恢复命令立即增加认证版本，并在同一事务中删除旧钥匙、旧会话、未完成挑战和旧邀请，再生成 30 分钟有效的新注册链接。不能用旧密码恢复，不能因一封陌生邮箱请求而恢复。新链接过期时，重新核验后再生成。账号 ID、项目角色和业务数据不变。邀请/恢复与认证完成写入 `auth_audit`；这不是防管理员篡改的外部审计系统。

## 会话与运维

- 会话为 256-bit 不透明随机值，数据库仅保存哈希；8 小时绝对有效期，不自动无限续期。匿名注册前会话有效 10 分钟，challenge 有效 5 分钟且一次消费。
- 生产 Cookie：`__Host-kp-session; HttpOnly; Secure; SameSite=Lax; Path=/`，不设置 Domain。开发 HTTP 使用 `kp-session`，仅此时没有 Secure。
- CSRF 令牌保存在页面内存，不是认证凭据。所有写请求要求固定 Origin、JSON 和匹配会话的 `X-CSRF-Token`；注册/登录也受保护。登录完成轮换会话 ID 和 CSRF 令牌。
- 注册和登录验证 challenge、origin、rpID、签名/注册结果、UP 和 UV；凭据与用户 ID 显式绑定。登录后仍按现有 memberships 检查每次业务访问。
- 禁止更换正式 hostname 后期待旧 Passkey 继续可用。变更域名/RP ID 必须安排重新核验及注册；不能简单放开任意 origin。
- 用户离职先移除其成员权限，并由管理员吊销全部钥匙、会话和邀请、增加认证版本。保护服务端 key 与平台管理账号，启用平台管理员 MFA。
- 到期 session/challenge/grant 在新匿名会话创建时清理；定期检查容量，按内部保留制度导出/清理 `auth_audit`。限流为单实例进程内限流，符合当前单免费实例范围，不是分布式抗 DDoS 服务。
- Supabase Free 无自动备份保障；管理员必须自行安全导出备份并演练恢复。不要把真实机密资料放入未获组织审批的免费云环境。

## 上线验收与回退

```sh
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm audit
```

自动测试使用临时 PostgreSQL、模拟发信 API 与真实 WebAuthn 签名，不会向真实邮箱发信。上线后必须在固定 HTTPS origin 验证：Outlook 实际收信（含垃圾箱与公司网关）、验证码确认、Passkey 创建、退出/登录、designer/IT 切换、IT 审批 API 拒绝、备用钥匙、服务重启后的会话和 Cookie 属性。SMTP2GO 接受邮件不代表 Outlook 已投递成功，需要后台报告与实际收件共同确认。虚拟认证器不能代替 Safari/Touch ID 或 Windows Hello 的实机验收。

若迁移/部署失败，保持站点维护状态并修复；新增表可保留，旧资料不变。禁止直接回退到公开注册/密码版本，否则重新暴露旧入口。恢复会吊销旧钥匙，不能仅回滚应用版本恢复它们，应重新邀请并验证。更换或恢复数据库时也必须考虑已吊销会话，不可将失效凭据无审查地恢复为有效。