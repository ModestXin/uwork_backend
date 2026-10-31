# uwork_backend 与开发体系结合：集成方案（2026-10-31）

状态：方案草案，待评审。主仓库 <https://github.com/Jas0nxlee/uwork_backend>，本文工作面 fork <https://github.com/ModestXin/uwork_backend>，分支 `integration/dev-system`。

目标：把管理后台 MVP 从"自带一份客户端副本的独立项目"变成"我们开发体系里可发布、可运维的一条主线"——客户端用主开发仓 `UWork-frontend`，模型上游用 AIHub/new-api，企微沿用现有自建应用，流程沿用同一套 spec/门禁/发布。

## 0. 结论先行

1. 后台本身是健康的：本机实测 `npm test` 312 项全通过、`tsc -p tsconfig.json`（src）通过、`npm run build` 通过（Node 24.22.2）。
2. 客户端适配**已经写完了**，但写在一份 88 MB / 7422 文件的 `clients/uwork`（UWork 3.16.0 整树副本）里。与本机主开发仓 `UWork-frontend`（0.1.5）的差异是 **345 个新增文件 + 243 个修改文件**。
3. 因此"结合"的关键动作只有一个：**把这份适配补丁移植进 UWork-frontend**，其余（部署、真企微、模型上游、发布注入）都是在既有两个开关上接线，不需要新造子系统。
4. 移植是可控的：用本文附带的 `scripts/port-client-adaptation.mjs` 实测，**144 个修改文件可干净三方合并，95 个有文本冲突**，冲突集中在 6 个文件（`ucasGatewayService.ts` 一个文件 20 处）。

## 1. 现状与证据（2026-10-31 实测）

| 项 | 事实 |
| --- | --- |
| 后台仓库 | `uwork_backend` 0.1.0，Node ≥24.13 <25，Fastify 5 + SQLite WAL 单实例，Node 24 工具链不在本机 PATH，已装到 `~/.cache/uwork-node24/node-v24.22.2-darwin-arm64` |
| 后台能力面 | 149 条路由：`/api/tenants` 101、`/api/client` 24、`/api/auth` 13、`/v1` 2（模型 OpenAI-compatible），见 `docs/api.md`、`docs/frontend-backend-alignment-audit-2026-10-21.docx` |
| 后台自检 | `npm ci --ignore-scripts` → `npm test` 312/312 通过；src typecheck 与 build 通过；**全量 `npm run typecheck` 在本机失败**，原因是 `scripts/*-smoke.ts` 用 `import type` 静态引了 `clients/uwork`，而该副本没有 `node_modules`（CI 同样只跑 `npm ci`，属仓库既有缺口） |
| 客户端适配 | `clients/uwork` = UWork v3.16.0 整树 + 517 文件补丁（345 新增 / 243 修改 / 4 目标已删 / 1 撞名） |
| 主开发仓 | `UWork-frontend` 0.1.5（2026-10-23 起为客户端主开发仓），上游 `Jas0nxlee/UWork` 已到 v3.16.8；发布走 GitHub Release + 企业微信 WeCom Drive |
| 双后端开关 | 客户端按 `enterprise-identity.json` 的 `backend: "ucas" \| "uwork"` 选择适配器；**缺省是 `ucas`**（`packages/services/src/node.ts`），`uwork` 分支才走自有后台 |
| 服务端现状 | 生产已有 `ucas-proxy`（control-plane / audit-proxy / new-api / mcp-gateway / msgbus）与 AIHub 域名；模型请求经 new-api 与审计代理 |

新增的适配补丁按位置分类：90 个源文件、104 个测试、57 个客户端 spec（其中约 28 个是 `enterprise-*` / `uwork-*` 主题）、23 个工具/文档。完整清单在 [adaptation-patch-report.json](adaptation-patch-report.json)。

## 2. 接缝一：客户端（主要工作量）

### 2.1 移植可行性（已实测）

| 类别 | 数量 | 处理方式 |
| --- | --- | --- |
| 新增文件 | 345 | 直接复制（目标已存在 1 个：`packages/desktop/scripts/desktop-product-identity.d.mts`，需比对） |
| 修改且可干净三方合并 | 144 | 工具自动落盘 |
| 修改且有文本冲突 | 95 | 逐个按双后端口径处理 |
| 目标已删除（上游 3.16.1–3.16.8 移除） | 4 | 决定是否恢复：`WorkspacePinnedTasksSection.tsx`、`releaseDownload.ts`、`updatePreparation.ts`、`scripts/prepare-prebuilds.mjs` |

### 2.2 冲突热点（95 个中前 6 个吃掉约 1/4）

| 文件 | 冲突块 | 根因 |
| --- | --- | --- |
| `packages/services/src/ucas-gateway/ucasGatewayService.ts` | 20 | 我们为 ucas 模式加了登录后自动配置/探测/投影；适配版为 uwork 模式加了会话中继与目录生命周期。**这是整个结合的设计核心** |
| `apps/zcode-cli/packages/adapters/src/mcp/index.ts` | 7 | 企业连接器准入 vs 上游 MCP 传输改动 |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | 7 | 企业准入装配点 |
| `packages/services/src/node.ts` | 7 | 适配器选择（`backend` 开关）与 Host 装配 |
| `packages/ui/src/ConversationSharePermissionPicker.tsx` | 7 | 企业分享策略 vs 上游分享 UI |
| `packages/desktop/src/host/index.ts` / `main/index.ts` | 6 / 6 | 客户端呈现桥与桌面装配 |

### 2.3 处理口径（建议）

- 保留双后端：`backend` 字段进 `@zcode/shared` 的 `wecomIdentityConfigSchema`，`ucas` 与 `uwork` 两条路径都留着，缺省仍是 `ucas`（不改变现网行为）。
- `ucasGatewayService.ts` 不整段二选一，拆成"共同内核（状态机、持久化、事件）+ 两个 provisioning 策略"：ucas 策略维持自动生成/复用 Key 与内网探测；uwork 策略走 Host 私有会话中继，**不向 Provider/Renderer 写供应商 Key**。两条策略都不得改变对方的状态所有者。
- 新增的 `enterprise-console` / `enterprise-assets` / `enterprise-model-relay` 模块与 UI 是纯增量，按文件搬即可；它们只依赖 Host 服务端口，不依赖 ucas 路径。
- 冲突文件逐个跑 `pnpm typecheck`/`lint`/`architecture:check --changed`，按批提交，便于回滚与定位。

### 2.4 落地顺序（每步一个可独立验收的提交序列）

| 批次 | 内容 | 验收 |
| --- | --- | --- |
| P0 | shared schema（`backend` 字段）+ 身份适配（`uworkIdentityAdapter`/`uworkBackendSession`）+ 模型中继最小链（`uworkGatewayClient` + `enterprise-model-relay` + `ucasGatewayService` 拆分）+ `node.ts` 装配 | 客户端 typecheck/lint/architecture 绿；本机指向本地后台跑通"合成身份登录 → 模型目录 → 一次真实对话 → 用量入账" |
| P1 | 企业控制台（`enterprise-console`）、资产宿主（`enterprise-assets`）与菜单/资产 UI | 菜单/资产/撤权在真实 Host 生效；客户端 spec 与单测绿 |
| P2 | CLI 适配（skills/connectors/model relay/tool authorization）、桌面呈现（`clientPresentation*`）、会话分享 | 打包 CLI 经 stdio 走企业准入；分享只读页与撤权闭环 |
| P3 | 生产落地（见 §3） | 单组织试点：真企微扫码 → 席位/限量 → 真实模型对话 → 审计/用量 |
| P4 | 收口：三仓 CI、发布注入、`clients/uwork` 降级为"补丁来源" | 发布包默认指向自有后台；`clients/uwork` 可用 `git subtree`/补丁工具再生成 |

## 3. 接缝二：服务端与基础设施

- **身份**：后台按租户保存 `corpId/agentId/credentialId`，扫码回调固定为 `{PUBLIC_URL}/api/auth/wecom/callback`，`state` 绑定 attempt，客户端配置里的 `orgId` = 后台 `tenantId`。我们现有三个企微自建应用需要各自把回调域指向后台域名（或为该后台单独建应用）。客户端已有多组织选择（设备偏好，只决定扫码用哪家应用，不参与授权判断），后台侧租户隔离是最终裁决——两者口径一致，不需要新协议。
- **模型**：后台 `/v1` 是 OpenAI-compatible 代理，上游可以是 AIHub/new-api。建议后台 Vault 里存 new-api 令牌，客户端不再持有供应商 Key（这与 ucas 模式"生成并 reveal Key 给客户端"是**行为差异**，需要在客户端文案与迁移说明里写清）。
- **与 ucas-proxy 的分工**：建议**并存不并联**。控制面（身份、席位、模型可见范围、资产、策略、客户端控制台）在哪个后端，模型/审计/IM 就跟随哪个后端；禁止"后台管策略、ucas 管身份"的拼接。IM（msgbus）、审计代理、MCP 网关继续留在 ucas-proxy；后台的 Agent Runtime/沙箱是新增能力，不替换手机远控。
- **部署**：`compose.yaml` 已就绪（loopback 绑定、只读 root、cap 全删、持久卷、单实例租约）。生产需要：域名 + TLS、`MASTER_KEY`（64 hex，独立备份）、数据卷 UID 1000、`PUBLIC_URL` 与浏览器 origin 完全一致、备份脚本纳入例行。SQLite 单实例是硬约束，多副本要先迁 PostgreSQL。
- **数据迁移**：成员/部门/角色/席位/模型/限量以企微与后台管理端重新建立（后台没有 WorkBuddy 生产数据，也不应回填历史账本）；历史用量留在 new-api/审计侧，不并入后台账本，避免两套计量相互污染。

## 4. 接缝三：研发流程

- **仓与分支**：后台在 fork 上开发，主线经 PR 回 `Jas0nxlee/uwork_backend`；客户端适配改动在 `UWork-frontend` 的独立 worktree/分支上做（避免与其他会话共享工作树互相覆盖）。
- **门禁**：后台 CI 已有 9 步（typecheck/lint/format/ledger/test/build/audit）+ Docker 沙箱作业；客户端侧沿用 `pnpm lint/typecheck/architecture:check` 与 spec-first。**新增跨仓一条**：客户端改动若触及企业准入，跑后台的 `scripts/port-client-adaptation.mjs` 干跑，确认补丁清单没有意外漂移（当前 345/144/95/1/4 即基线）。
- **本地工具链**：后台 `engine-strict` 要求 Node 24，本机默认 Node 25 会直接拒装；统一用 `~/.cache/uwork-node24/node-v24.22.2-darwin-arm64/bin`。`clients/uwork` 若要跑客户端测试还需在其内 `pnpm install`（约 88 MB 源码 + 依赖），这是全量 `typecheck` 在本机为红的原因，建议把 `scripts/*-smoke.ts` 里对 `clients/uwork` 的静态 `import type` 改成 `import()` 动态引用，或把该依赖标成可选。
- **发布**：客户端正式包通过 GitHub Actions secret `UWORK_ENTERPRISE_IDENTITY_CONFIG` 注入 `resources/config/enterprise-identity.json`（严格五字段）。切入自有后台 = 该 JSON 增加 `backend: "uwork"` 并把 `apiBaseUrl/callbackUrl` 指向后台域名；回滚 = 去掉 `backend` 字段即回 ucas。分发仍走 WeCom Drive 同步工作流。
- **文档**：后台的 spec/验收台账（`SPEC-*.md`、`docs/acceptance.md`、`docs/api.md`）继续作为服务端事实源；客户端侧新增/修改的 spec 随补丁进 `UWork-frontend/specs/`。给管理员/行政的说明单独写，不复用工程口径。

## 5. 决策点（默认已按推荐执行，需要否决请说）

1. 客户端适配落点：**移植进 `UWork-frontend`**（默认），`clients/uwork` 降级为补丁来源与联调参考。
2. 与 ucas-proxy 的关系：**先并存、按安装/组织切换**，不做身份拼接；收敛留到试点之后。
3. 模型上游：**AIHub/new-api**（默认），直连供应商仅作厂商专有协议时的例外。
4. 首发范围：**单组织试点**（一个 tenant + 一个企微应用 + 一批内部成员），再放量。

## 6. 风险与回滚

| 风险 | 控制 |
| --- | --- |
| 双后端误配（缺省 ucas，配错就连回旧服务） | 发布配置校验（缺 `backend` 视为显式 ucas）+ 客户端设置页显示当前后端；回滚只需改发布 secret |
| 95 个冲突文件的语义回归 | 分批提交 + 每批门禁 + 独立 worktree；`ucasGatewayService` 先拆结构再填行为 |
| 计量口径冲突（Credit vs new-api 账单） | 后台 Credit 只作内部计量，明确不声称等于账单；对账走 `reconcile` |
| SQLite 单实例/主密钥丢失 | 例行 `npm run backup` + `MASTER_KEY` 独立受保护备份；升级前先备份快照 |
| 身份并存期成员困惑 | 试点期间同一成员只用一条后端；管理端「有效权限」入口用于排查 |

## 附录 A：移植工具与复现命令

```sh
export PATH=~/.cache/uwork-node24/node-v24.22.2-darwin-arm64/bin:$PATH
git -C <UWork 仓库> archive v3.16.0 | tar -x -C /tmp/uwork-base-3.16.0
# 干跑（不写文件）并产出报告
node scripts/port-client-adaptation.mjs --baseline /tmp/uwork-base-3.16.0 \
  --target ../UWork-frontend --report docs/integration/adaptation-patch-report.json
# 在目标工作树的独立分支上落盘干净部分（冲突文件不动）
node scripts/port-client-adaptation.mjs --baseline /tmp/uwork-base-3.16.0 \
  --target ../UWork-frontend --apply
```

## 附录 B：本轮本机验证

| 命令 | 结果 |
| --- | --- |
| `npm ci --ignore-scripts`（Node 24.22.2） | 通过 |
| `npm test` | 312 项通过、0 失败 |
| `npx tsc -p tsconfig.json --noEmit` | 通过 |
| `npm run typecheck` | 失败：`scripts/*-smoke.ts` 静态引用未安装依赖的 `clients/uwork`（既有缺口，非本次改动） |
| `npm run build`（tsc + vite admin） | 通过 |
| `node scripts/port-client-adaptation.mjs`（干跑） | added 345 / clean-merge 144 / conflict 95 / collision 1 / absent 4 |
