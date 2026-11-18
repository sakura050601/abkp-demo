# 当前 Passkey 版本的 AWS 发布操作指南

2026-11-18｜项目：abist-design-knowledge-demo

本次保留公司邮箱验证、Passkey 登录、应用内用户资料、角色和审批逻辑。继续使用现有 Supabase 数据库和 SMTP2GO 邮件服务。IAM Identity Center／统一登录另行讨论。

## 1. 已确认的状态与本包作用

| 项目 | 本次实际确认 |
|---|---|
| 源码 | GitHub main：f97b20a017c38a8ba8e612e67beb890be4a7a42a；不包含你 Mac 上尚未提交的代码 |
| 自动测试 | 33 项现有测试通过；Vite 前端构建通过 |
| 浏览器测试 | 执行环境无法启动 Chromium，尚未通过；上线前仍需浏览器验收 |
| ECS 集群 | abist-design-knowledge-demo-cluster，Active；0 个 Service、0 个运行任务 |
| ECR | abist-design-knowledge-demo，仓库存在、标签不可覆盖；检查时无镜像 |
| CloudShell | cloudshell:CreateEnvironment 被拒绝；本次改用你的 Mac 构建，不要求增加此权限 |
| AWS 上线 | 尚未完成；镜像、HTTPS、运行配置和登录验收仍待完成 |

本包只新增 deploy 目录，不修改 server、client、shared、supabase 中的业务或认证代码。Dockerfile 把前端与 API 放在同一个容器和同一个访问域名下。构建脚本会先测试、构建、检查容器，再上传到指定 ECR；它不会创建或更新 ECS 服务。

## 2. 把文件放进你正在使用的项目

下载并解压发布包，把其中的 deploy 文件夹复制到你 Mac 的 abist-kp-demo 项目根目录，与 package.json 同级。不会替换你原有的根目录 Dockerfile。

在 Terminal 进入该项目。可输入 cd 加一个空格，再将 Finder 中的项目文件夹拖入 Terminal，按回车。

```bash
pwd
git status --short
node --version
ls deploy
```

Node.js 需为 22 或更新版本。若你有未提交的业务代码，先核对并按平时流程提交；脚本会暂停，避免镜像对应的源码版本不清楚。不要覆盖或丢弃这些修改。

## 3. 确认 Docker、Buildx、Colima 能工作

先运行：

```bash
docker buildx version
docker version
colima status
```

成功标准：Buildx 显示版本；docker version 同时显示 Client 和 Server。只有 Client、出现 docker.sock 错误，说明 Docker Engine 尚未连接。

如果没有安装 Colima 或 Buildx：

```bash
brew install colima docker-buildx
```

如果安装后 docker buildx 仍不存在，用以下命令把 Homebrew 插件目录加入 Docker 配置。命令会保留原有字段、备份配置，不输出已有登录信息。

```bash
ABKP_BREW_PREFIX="$(brew --prefix)" node --input-type=module <<'NODE'
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const dir = process.env.DOCKER_CONFIG || join(homedir(), '.docker');
mkdirSync(dir, { recursive: true });
const file = join(dir, 'config.json');
const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
if (cfg.cliPluginsExtraDirs !== undefined && !Array.isArray(cfg.cliPluginsExtraDirs)) throw new Error('cliPluginsExtraDirs is not an array; inspect the configuration locally');
if (existsSync(file)) copyFileSync(file, `${file}.backup-${Date.now()}`);
cfg.cliPluginsExtraDirs = [...new Set([...(cfg.cliPluginsExtraDirs || []), join(process.env.ABKP_BREW_PREFIX, 'lib/docker/cli-plugins')])];
const temporary = `${file}.abkp-tmp-${process.pid}`;
writeFileSync(temporary, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
renameSync(temporary, file);
console.log('Docker plugin directory configured.');
NODE
```

如果 Colima 尚未运行：

```bash
colima start --cpu 4 --memory 4
```

已有可用 Docker Engine 时无需额外启动一台虚拟机。再检查：

```bash
docker context show
docker version
docker buildx version
docker buildx inspect --bootstrap
```

最后一项的 Platforms 应包含 linux/amd64。若没有，或仍报错，保留报错继续排查；不要执行 colima delete，也不要为修复本机构建去更改 QA 资源。

## 4. 构建并上传 ECR

在项目根目录执行：

```bash
aws sts get-caller-identity --profile abist-design-knowledge-demo --no-cli-pager
bash deploy/build-and-push.sh push
```

如果 AWS 会话过期，先使用你已验证成功的登录方式重新登录，再执行上述命令：

```bash
aws login --profile abist-design-knowledge-demo --region ap-northeast-1
```

脚本会依次完成：校验 AWS 账号和 ECR → 检查 Docker／Buildx → 安装锁定依赖 → 33 项现有测试 → 构建 linux/amd64 镜像 → 本地容器启动检查 → 登录 ECR → 推送 → 查询镜像摘要。

本地容器启动检查使用临时演示模式，不连接真实数据库；确认前端可访问、健康检查正常、未登录 API 返回 401。正式镜像默认 DEMO_MODE=false，真实 Passkey 与数据库仍须在部署后验收。

每次使用包含时间和源码版本的新标签，兼容当前 ECR 的 Immutable 设置。成功后显示 image、digest、sourceCommit，并保存在 .data/last-ecr-push.json。这里的 ecsDeployment: not-started 表示镜像已上传，但网站还未上线。

仅构建、不上传时用：

```bash
bash deploy/build-and-push.sh build
```

## 5. 上传后配置独立 ECS 服务

以下是待执行的配置，不代表已经创建。保持区域为东京 ap-northeast-1。

| 控制台项目 | 填写／选择 |
|---|---|
| Cluster | 已存在的 abist-design-knowledge-demo-cluster |
| Service 名称 | 拟新建 abist-design-knowledge-demo-service |
| Image | 第 4 步实际输出的完整镜像 URI；保留 digest 作为版本凭据 |
| Launch type | Fargate |
| CPU architecture | X86_64，与 linux/amd64 镜像一致 |
| Container port | 3001 / TCP |
| CPU / Memory | 初次试运行可从 0.25 vCPU / 0.5 GiB 开始，按日志和负载调整 |
| Desired tasks | 初次验证 1；这不是高可用配置 |
| Health check | /api/health；200；首次启动宽限期可先设 60 秒 |
| Logs | 拟新建 /ecs/abist-design-knowledge-demo；可先保留 7 天 |
| Network | 使用明确允许本 Demo 使用的 VPC、子网及专用安全组；记录具体 ID 后再创建 |
| Execution role | 能拉取此 ECR 镜像、写日志、读取指定密钥的角色；部署者还需对该角色的 iam:PassRole |
| Task role | 当前应用不因登录而需要 IAM 用户查询权限；仅在代码确实调用 AWS 服务时按需配置 |

不要选择或修改 qa-system-* 的 Service、Task、负载均衡器、安全组或 IAM 角色。独立 Cluster 不会自动隔离 VPC、入口和角色；不能据此认定这些资源可共用。

普通 ECS Service 不会自动提供适合 Passkey 的 HTTPS 网站地址。AWS 的 ECS Express Mode 可以生成 HTTPS 入口，但会创建负载均衡等收费资源、需要 Execution role 和 Infrastructure role；它也是一种可选实施路径。采用时明确选择本 Demo 集群与获准网络，不能直接接受 Default cluster／网络默认值。生成地址后需要将 AUTH_ORIGIN 对齐该地址并更新服务，再验收登录。当前尚未配置或采用该模式。

因此，第 4 步完成后，下一步先核对本 Demo 可用的执行角色、网络和 HTTPS 入口；不能仅凭一个 HTTP ALB 地址宣告上线。

## 6. 运行配置与数据保存

通过 ECS 的环境变量／Secrets 配置以下项目；敏感值从现有 Render 配置安全转入 Secrets Manager，并在任务定义中引用，不能放入镜像、Git、聊天或截图。不要为了这次发布重建数据库。

| 配置 | 应设置为 |
|---|---|
| NODE_ENV | production |
| PORT | 3001 |
| DEMO_MODE | false；否则变为另一套临时演示登录和本地文件保存 |
| AUTH_ORIGIN | 实际固定 HTTPS 地址；不带末尾 /，不带路径 |
| WEBAUTHN_RP_ID | 可不设置；默认使用 AUTH_ORIGIN 的主机名。若保留此变量，必须与新主机名相同 |
| SUPABASE_URL | 当前应用实际使用的 Supabase 项目地址 |
| SUPABASE_SERVICE_ROLE_KEY | 服务器专用密钥，使用 Secrets 引用 |
| MAIL_FROM | SMTP2GO 已验证的发件人 |
| SMTP2GO_API_KEY | 当前邮件服务密钥，使用 Secrets 引用 |
| EMAIL_CODE_SECRET | 现有长度至少 32 字符的随机密钥，使用 Secrets 引用 |

VITE_API_URL 在镜像构建时为空，前端请求同域 /api。不要设置 AUTH_TEST_MAIL_URL，不要把 service_role 密钥作为 VITE_* 变量暴露给浏览器。

出站网络需能通过 HTTPS 到达 Supabase 和 SMTP2GO；私有子网的 NAT／VPC 端点能力要单独核对。ECR、CloudWatch、Secrets Manager 的访问也需满足任务启动条件。

应用内 app_users、memberships、project_states 等表继续位于现有 Supabase。这里的“内置用户表”是应用管理的持久数据库，不是 ECS 容器磁盘。本次不新增部门字段，不修改角色和审批逻辑。

若当前数据库已正常服务 Render，不执行清库、seed:demo 或重复导入示例数据。仅在新建空数据库的独立场景下，才按现有 README 执行 schema.sql 与 auth:init；这不属于本次默认步骤。

## 7. 新域名下的 Passkey 处理

Passkey 绑定网站 RP ID。原 abkp-demo.onrender.com 下的 Passkey 不能直接用于另一个 AWS 主机名。用户记录和业务数据可以保留，但已有用户需要在新域名重新绑定。

当前代码已包含受控恢复命令。由管理员核实用户身份后，在安全运行环境中配置真实数据库凭据、DEMO_MODE=false 和新的 AUTH_ORIGIN，再针对该用户执行：

```bash
npm run auth:recover -- --email '实际用户@abist.co.jp' --verified-by '实际核验者与核验方式'
```

此命令会立即撤销该用户所有旧 Passkey 和会话，包括仍连接同一数据库的 Render 会话；保留用户 ID、成员关系与业务数据。它输出一个 30 分钟内有效、一次性的重新绑定链接。只私下交给已核验本人，不贴到群聊或公开日志。

因此先用专用测试用户验收新入口，再安排真实用户迁移。不要为了重新注册而删除 app_users；已经存在的邮箱也不能直接当成全新用户再次注册。新用户仍可走“会社メールで新規登録”流程。

## 8. 上线验收与失败处理

以下检查全部完成，才能说 AWS 版本可用：

1. ECS Service 有运行中的 Task，健康检查通过，日志没有数据库配置错误。
2. 打开实际 HTTPS 地址，证书正常，/api/health 返回 ok: true、mode: supabase。
3. /api/config 返回 demo: false、authMode: passkey；未登录访问 /api/state 返回 401。
4. 测试用户收到公司邮箱验证码，注册 Passkey，退出后再次登录成功。真实邮件与 Touch ID／设备验证需人工确认。
5. 用测试账号填写资料、保存测试知识，再刷新页面，确认数据仍在；按现有业务流程验证角色与审批。
6. 针对本 Demo 替换任务并恢复服务后，数据仍可读取。仅 /api/health 返回 200 并不证明数据库持续可用。
7. 确认浏览器请求全部进入新域名，没有残留 Render API 地址。

初次发布失败时，保留现有 Render 服务和数据库，检查 Demo 任务日志；不要删除数据库或 QA 资源。若已执行用户恢复，旧 Passkey 已撤销，单纯退回旧 URL 不会恢复它们，需要单独处理该用户的重新绑定。

当前自动化未覆盖真实 AWS HTTPS、真实公司邮箱投递或真实设备 Passkey。没有完成这些检查前，不对外宣告正式可用。

## 官方参考

- Colima：https://github.com/abiosoft/colima
- Homebrew Buildx：https://formulae.brew.sh/formula/docker-buildx
- ECR 镜像推送：https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html
- ECS Express Mode：https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-create-full.html
- Passkey 服务器校验：https://simplewebauthn.dev/docs/packages/server
