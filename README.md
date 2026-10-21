# 設計ナレッジ / Knowledge Studio

根据用户提供的 14 页 Google Slides《設計ナレッジ入庫基盤》实现的响应式演示平台。界面沿用日文，开发/部署说明为中文。前端 React + Vite，后端 Express，数据库可切换本地 JSON 与 Supabase PostgreSQL；不需要付费组件或 AI API。

## 界面更新

首页改为任务列表，提供我的任务、草案/退回、全部及搜索。移除宣传横幅、英文标语和流程讲解；登录及资料向导缩短文案。业务字段、审批规则和已保存数据保持不变。

## 本地运行

需要 Node.js 22（建议最新维护版本）。在本目录执行：

```sh
npm ci
cp .env.example .env
npm run dev
```

打开 http://127.0.0.1:5173 。API 位于 http://127.0.0.1:3001 。如端口被占用，先停止已有服务。`.env` 已在当前交付目录中准备好，仅包含公开演示设置，不含任何个人密钥；ZIP 中不包含 `.env`。

演示密码均为 `knowledge-demo`，可通过 `DEMO_PASSWORD` 修改：

| 账户 | 身份 | 用途 |
|---|---|---|
| 藤井 美咲 | designer | 投稿、本人前序确认、改订 |
| 田中 健一 | designer | 最终确认之一 |
| 佐藤 直樹 | senior | 资深设计师最终确认 |
| 山本 葵 | viewer | 只读权限检查 |

演示数据存于 `.data/state.json`，进程重启后数据保留，但演示登录会话需要重新登录。仅使用虚构资料。Supabase 模式不存在这些默认登录账户。

## 5 分钟演示脚本

1. 用藤井账户登录，选择「新規登録」。
2. 点「サンプル」，勾选保存授权，然后「デモ抽出を開始」。
3. 检查条件、判断、理由、依据和未确认事项。选择问题候选，勾选确认。选择「どちらでもない・保留」后可保存草案，之后在卡片页重新选择。
4. 前两道确认可指定本人，最终确认选田中与佐藤。可增加前序步骤、调整顺序和人员。提交申请。
5. 在卡片页面，用藤井依次点击两次「承認」，完成前两道确认。
6. 手机端打开左上菜单，点击底部账户退出。切换田中，在「承認タスク」打开卡片，选择重要度、优先度、主/副后批准。
7. 切换佐藤，以相同选定标准批准。两人一致后「コアナレッジ」出现固定的已批准版本。
8. 也可在前序确认输入理由后退回。藤井增加补充资料，保存为新版本后重新申请。已入库卡片改订不会覆盖既有核心快照。

## 与 PPT 的对应

| PPT 页面 | 实现 |
|---|---|
| 1–5，三层及关联 | 原资料 raw、卡片 cards、核心 cores；各自 ID、原资料版、卡片版、批准快照 |
| 6，资料追加 | 会话文本 + 4 类入口，最多 2 个文件/每个 2MB，真实保存与下载 |
| 7，候选确认 | 明确标识模拟抽取，候选选择和保留；任意资料保持未确认 |
| 8，路径设置 | 指定人员、增加步骤、调整顺序；最后两位不同人员含 senior |
| 9，审查 | 卡片与原文对照、批准/退回/拒绝、理由记录 |
| 10–11，结构化及版本 | 条件、判断、理由、依据、限界，草案与过去版本、核心快照 |
| 12–14，试行及评估 | 演示数据、角色切换、操作履历、关键词搜索 |

## 当前实现边界

- **没有真实 AI/OCR/视频/图纸解析**。只有内置样例产生固定模拟结果；任意其他资料可保存，但不能把不完整的结果批准入库。将来可在 `shared/domain.js` 的 `extract()` 后添加异步抽取服务，不应让模型直接改变审批状态。
- 模拟卡片的正文目前只读；补充资料会更新限界/未确认说明并产生新版本。通用人工编辑、多候选批量校核、多个卡片的自动生成属于后续扩展。
- 三层目前是同一项目 JSONB 聚合内的三个逻辑集合，不是三台数据库。Supabase 的 `project_states` 用 revision 条件更新，实现整次审批及历史的原子提交。适合小规模演示；大量数据应迁移至独立 raw_sources/card_versions/core_entries/approval_events 表及数据库事务。
- 附件以 Base64 与原资料一起保存，下载强制为二进制文件。仅适合少量演示文件；生产应迁移至私有 Supabase Storage、签名下载、扫描与配额控制。新增卡片最多 2 个附件，补充资料目前支持文本。
- 权限范围为整个项目，三个角色 designer/senior/viewer；未实现逐文件机密分级、组织级 SSO、MFA、细粒度 ACL。所有项目成员可看该项目所有资料。后端从成员表获取身份/项目，不信任前端传来的角色。
- 当前每个用户使用其最早加入的一个项目，无跨项目切换界面。流程串行确认，最终两位确认可按任意顺序完成；没有复杂分支、代理人、通知、催办或 Oracle BPM 集成。
- 退回统一生成新版本并从第一步重新审核，属于简化流程。已拒绝申请不可重新提交；可用新资料创建新申请。
- 核心快照保留过去已批准版本，同一卡片多次批准会产生多份版本记录；尚无“当前有效版本”替换/废止功能。
- 操作履历为业务审计记录，不是独立防篡改合规日志。当前 RLS、跨项目隔离 SQL 已提供，但没有连接真实 Supabase 项目进行联调。

## Supabase 配置

1. 新建 Supabase 项目，在 SQL Editor 运行 `supabase/schema.sql`（仅首次）。
2. 在 Authentication → Users 创建 3 个演示人员的邮箱/密码账户（至少一名 senior）。不要将 service role key 放到前端。
3. 用 SQL 为项目与成员配置数据。以下 UUID 都替换成真实值；PROJECT_UUID 可由 `select gen_random_uuid();` 生成：

```sql
insert into public.projects(id,name) values ('PROJECT_UUID','設計事業部');
insert into public.project_states(project_id) values ('PROJECT_UUID');
insert into public.memberships(project_id,user_id,display_name,role) values
('PROJECT_UUID','AUTHOR_AUTH_UUID','藤井 美咲','designer'),
('PROJECT_UUID','REVIEWER_AUTH_UUID','田中 健一','designer'),
('PROJECT_UUID','SENIOR_AUTH_UUID','佐藤 直樹','senior');
```

4. 后端环境变量设置：

```dotenv
DEMO_MODE=false
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_ONLY_SERVICE_ROLE_KEY
CLIENT_ORIGIN=https://YOUR_FRONTEND.vercel.app
```

5. 启动后，登录页自动变成邮箱/密码登录；Supabase Auth 在后端通过 `getUser(token)` 验证。通过服务端成员表授权后，后端才访问所属项目的数据。
6. 数据表开启 RLS；authenticated 只能读取自己所属项目，不能直接写表。后端 service_role 用于受控写入；不要向用户客户端授予此 key。成员和角色目前在 Supabase 控制台管理。

## 部署到 Render（后端）

1. 将本目录内容推送至自己的 Git 仓库。ZIP 不包含 node_modules、环境变量或本地资料。
2. Render 选择 New Web Service，连接仓库。根目录设为本项目所在目录。
3. Build command: `npm ci`；Start command: `npm start`；Health check: `/api/health`。仓库内提供 `render.yaml`，也可用 Blueprint。
4. 按上一节配置环境变量，使用 `DEMO_MODE=false`。后端监听 Render 提供的 `PORT` 和 `0.0.0.0`。
5. 获取 Render HTTPS 地址，浏览器访问 `/api/health` 应返回 `mode: supabase`。注意这只是进程健康检查，之后还要真实登录并提交一条样例验证数据库。

不要在 Render 免费实例上用本地 JSON 保存正式数据；实例文件不应作为持久化存储。服务的休眠、免费配额和可用性以各提供商控制台为准。

## 部署到 Vercel（前端）

1. Vercel 导入同一仓库，根目录与上面一致。
2. Framework 选择 Vite；Build `npm run build`；Output Directory `dist`。已提供 `vercel.json`。
3. 设置前端构建变量 `VITE_API_URL=https://YOUR_API.onrender.com`，不要带结尾斜线。修改后要重新部署。
4. 在 Render 的 `CLIENT_ORIGIN` 填入完整 Vercel origin（无末尾斜线），多个受控域名可用逗号分隔。
5. Supabase Auth Site URL 设置为正式 Vercel 地址。此版本使用密码登录，不依赖 OAuth redirect；以后加邮箱重置/OAuth 时再配置对应 Redirect URLs。
6. 不需要将 service role key 配到 Vercel。前端从 `/api/config` 获取 Supabase public anon key，该 key 是公开客户端凭据，权限依赖 RLS 和后端授权。

前后端分开部署时不要把 `/api` 转发给 Vite；客户端通过 `VITE_API_URL` 直接调用 Render。可选的免费服务方案不等于永久零费用保证。

## 验证

```sh
npm test
npm run build
```

已验证：7 项领域测试 + 1 项独立临时数据目录 HTTP 集成测试，覆盖未登录/错误密码、只读权限、错误审批人、重复审批、同一选定标准、保留候选、重审、固定核心版本、并发 revision 冲突、拒绝及注销。浏览器检查了窄屏登录、资料向导、候选确认、路径配置和提交后的审查页面。未部署外部云端；真实 Supabase Auth/数据库仍需配置后联调。

## 文件导航

- `client/src/main.jsx`：页面和交互（为方便 demo 初期维护集中实现，可后续拆分路由组件）。
- `client/src/style.css`：桌面、平板、手机断点。
- `server/index.js`：HTTP API、登录验证、授权、数据适配、乐观锁。
- `shared/domain.js`：资料/卡片/核心状态流转、审批与版本规则。
- `supabase/schema.sql`：项目、成员、状态聚合、RLS 和授权。
- `tests/`：业务规则与真实 HTTP 集成测试。

## 参考

- 原始设计：[Google Slides](https://docs.google.com/presentation/d/1wnOicA2zf2KJPgIFTbBYNBGJ1xapCg7GmaaJZzQEp7E/edit)
- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Deploy Node Express on Render](https://render.com/docs/deploy-node-express-app)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase user management](https://supabase.com/docs/guides/auth/managing-user-data)
