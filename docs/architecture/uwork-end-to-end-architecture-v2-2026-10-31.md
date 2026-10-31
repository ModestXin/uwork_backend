# UWork 端到端架构 V2（2026-10-31）

状态：重规划草案，待评审。取代 `UWork/docs/architecture/uwork-overall-architecture.md`（概念版 V1）中"企业服务群"与"模型接入"两章；客户端分层、数据根、手机远控等章节继续有效。

读者：做实现与运维的人。V1 是给决策者看的概念版，本文是**目标架构 + 取舍**：谁拥有什么事实、一次请求走哪条路、审计在哪一层、哪些边界不能破。

## 0. 一句话

**客户端只认一个企业后台；所有模型流量只经过一个治理点；所有正文留存只落一处；所有计量只认一本账。**

V1 的形状是"客户端 + 三类后台"，其中企业身份与 API Key 由 ucas-proxy 控制面持有，客户端拿 Key 直连模型网关。V2 把**身份、策略、资产、账本的权威移到 `uwork_backend`**，客户端不再持有任何模型凭据，模型请求由后台代理出去，仍经现有审计代理落到 new-api。IM 与工作项留在 msgbus，通过令牌联邦信任后台身份。

## 1. 五条不变式（先破哪条都会出事故）

| # | 不变式 | 违反后的症状 |
| --- | --- | --- |
| I1 | **一个安装只认一个身份后端**（`backend: ucas \| uwork`），不存在"身份在 A、策略在 B"的拼接 | 两套会话、两套席位，撤权不生效 |
| I2 | **模型凭据不落客户端**：客户端只持企业会话/设备令牌，new-api 令牌只在服务端 vault | Key 出现在 Renderer/CLI/日志，泄漏面回到 V1 |
| I3 | **模型正文只留一处**：audit-proxy 是唯一请求/响应正文留存点；后台不复制正文 | 两套留存口径、两套保留期、审计对不上 |
| I4 | **计量只认后台账本**：Credit 是内部计量单位，new-api 额度是供应商侧口径，只用于对账 | 员工看到两套用量、两个额度 |
| I5 | **凭据不跨界**：企业会话令牌 / 上游 new-api 令牌 / 手机配对口令三类互不借用 | 一条链路被攻破即横向扩散 |

## 2. 总体形状

```text
                        ┌────────────── 用户入口 ──────────────┐
                        │ 桌面客户端（macOS/Win/Linux）          │
                        │ 手机网页 /remote/v4 · 安卓壳（只读附着）│
                        │ CLI / agent（经 Host 私有会话）        │
                        └───────────────────┬──────────────────┘
                                            │ HTTPS / WSS
                        ┌───────────────────▼──────────────────┐
                        │ 边缘 nginx（TLS 终止、按域名/路径分流） │
                        └──┬──────────┬──────────┬──────────┬───┘
                           │          │          │          │
        ┌──────────────────▼──┐  ┌────▼─────┐  ┌─▼────────┐ │
        │ 控制面 uwork_backend │  │ msgbus   │  │ 中继 relay│ │
        │ 身份 / RBAC / 席位    │  │ IM/工作项 │  │ 设备配对  │ │
        │ 资产 / 策略 / 控制台  │  │ /汇报    │  │ 帧转发    │ │
        │ 运行 / 账本 / 审计    │  │ (JWT 联邦)│  └──────────┘ │
        │ `/api/*` `/v1/*`     │  └──────────┘               │
        └─────────┬───────────┘                             │
                  │ 服务端到服务端（内网，带租户令牌）           │
        ┌─────────▼───────────┐                             │
        │ audit-proxy          │  ← 正文留存/护栏/DLP/停用/缓存 │
        └─────────┬───────────┘                             │
                  │ internal 网络（不对公网发布端口）           │
        ┌─────────▼───────────┐                             │
        │ new-api + PostgreSQL │──▶ 上游模型供应商（公网出口）  │
        └─────────────────────┘                             │
                                                              │
        内容源 AIHub（技能市场 / 手机页静态托管）◀───────────────┘
```

与 V1 的差别只有三点，但每一点都改变数据流：

1. **控制面从 ucas-proxy 换成 uwork_backend**：身份、席位、模型可见范围、资产、客户端策略、Agent 运行时、账本都在这里。
2. **客户端不再持有模型 Key**：模型请求走 `{backend}/v1`，由后台鉴权、限量、预留、转发、结算。
3. **审计代理不再对客户端暴露**：它只接受后台的服务端调用；面向旧安装的 `llm.` 入口继续存在，但新装量不走。

## 3. 模块与事实所有者

| 模块 | 拥有的权威事实 | 明确不负责 | 对外入口 |
| --- | --- | --- | --- |
| 客户端内核 | 本机会话、任务队列、工具执行、工作区身份 | 不持有企业身份/模型凭据；不直接调后台业务接口 | — |
| 控制面 `uwork_backend` | 租户、成员、角色、席位、资产版本、策略快照、客户端配置、账本、管理审计、Agent 运行 | 不保存模型请求/响应正文；不代替 new-api 做供应商路由 | `https://uwork.<domain>`：`/`（管理 Web）、`/api/*`、`/v1/*`、`/share/{code}` |
| 模型治理点 `audit-proxy` | 请求/响应正文、提示词护栏、出站 DLP、模型停用名单、语义缓存、按 key 的余额/预算 | 不做身份签发；不做员工级额度（那是后台账本） | 仅内网 `audit-proxy:3100`（旧装量保留 `llm.` 公网入口） |
| 上游网关 `new-api` | 渠道/供应商路由、模型定价、上游额度与故障切换 | 不面向客户端；不承担企业管理语义 | 仅内网，无公网端口 |
| 消息 `msgbus` | 会话、消息、未读、在线状态、工作项、汇报、审核 | 不签发企业身份（只验签） | `{backend 同源}/ws`、`/api/conversations`、`/api/work-items`、`/api/reports` |
| 中继 `relay` | 设备配对、房间、帧转发 | 不知道身份、不存任务状态、不存正文 | 独立容器 + AIHub 反代 |
| 内容源 AIHub | 技能市场目录（匿名）、手机远控页静态托管 | 不参与企业身份与授权 | `aihub.ucas.com.cn` |
| 管理 Web | 无（全部事实归控制面 API） | 不直连数据库、不读上游凭据 | 与 API 同源 |

**关键分工**：企业管理语义只在 `uwork_backend`；模型侧执行语义只在 `audit-proxy` + `new-api`；两者之间只有一条带租户令牌的内部 HTTP 调用，不共享数据库、不共享身份表。

## 4. 四条主链路

### 4.1 登录与装配

```text
桌面生成 attempt（随机 proof）→ 企微扫码 → 回调 {backend}/api/auth/wecom/callback
  → 后台用租户自己的 corpId/secret 换成员身份 → 一次性 claim 返回会话
  → Host 加密保存会话；Renderer 只拿无凭据视图
  → 装配：GET /api/client/configuration（菜单/新对话/安全/个人策略，ETag 缓存）
          GET /api/client/entitlement（席位/订阅/有效额度）
          GET /v1/models（本人可见模型）
          GET /api/client/assets（企业管理的技能/专家/连接器）
```

与 V1 的差别：**这一步不再生成、下发、保存任何 API Key**；退出登录只清会话，模型访问随之失效（这是有意的：没有会话就没有模型）。

### 4.2 一次对话（核心链路）

```text
界面输入 → 窗口宿主 → 会话运行时（命令串行准入）
  → 模型接入层组装请求
  → Host 私有会话：POST {backend}/v1/chat/completions   Authorization: 企业会话/设备令牌
  → 后台：验会话 → 查成员/席位/订阅/模型可见性/IP → 事务内预留额度
         → 注入归因头 X-UWork-{Tenant,Member,Organization,Session,Correlation}
         → 用租户级 new-api 令牌转发到 http://audit-proxy:3100/v1/chat/completions
  → audit-proxy：护栏注入/DLP/停用名单/正文留存 → new-api → 上游模型
  → SSE 逐段回传 → 后台按真实 usage 结算 → 账本（settled/uncertain）
  → 运行时产出事件 → 界面渲染
```

要点：

- **流式**：文本 SSE 逐段转发；带工具调用的响应在后台重组后才转发（计量与幂等先落库）。这一条是延迟换正确性，已在后台合同里固定。
- **失败语义**：已分派但没拿到完整结果 → `uncertain` 并占用预留，不假定上游免费；DNS/连接前失败 → 释放预留。取消/超时/重启都不重放。
- **撤权时点**：分派前、每个 SSE 片段、完整响应成功前都重查成员/席位/模型/策略；已发出的片段无法收回，这是已知边界。
- **旧装量**：`backend: ucas` 仍走"客户端持 Key → `llm.` → audit-proxy → new-api"，与新链路并行但**不交叉**；同一成员同一时间只用一条。

### 4.3 企业资产与工具

```text
技能/专家：后台按版本审核发布 → 客户端清单（带 checksum/版本）→ 下载与本地安装
           → 使用前 /api/client/authorize?action=asset 逐次裁决（撤权即拒）
连接器（MCP）：客户端 → {backend}/api/client/connectors/{id}/rpc
           → 后台注入 vault 里的远端凭据 → 远端 MCP → 结果脱敏回传
```

与 V1 的差别：**企业管理的 MCP 不再走独立 mcp-gateway**。mcp-gateway 只继续服务旧装量；新装量的企业工具全部经后台连接器代理，权限、版本、凭据都在后台一处。个人技能市场（AIHub SkillHub）保持匿名，不参与企业授权。

### 4.4 消息、工作项与汇报（身份联邦）

```text
客户端 → {backend 同源}/ws、/api/conversations、/api/work-items、/api/reports
       → nginx 按路径分流到 msgbus
       → msgbus 验签（HS256，claims: userId/orgId/role）→ 业务
```

身份联邦是最小改动方案：**后台按与 msgbus 约定的共享密钥签发同 claims 的短时 JWT**（首帧携带，不进 URL），msgbus 不改存储与业务。长期可换成 JWKS/非对称密钥，但一期不做。

边界：msgbus 保留消息原文（撤回只做删除标记），这是消息审计的事实源；后台不复制消息正文。

## 5. 模型接入

### 5.1 三层，各有唯一职责

| 层 | 职责 | 变化频率 |
| --- | --- | --- |
| 后台模型目录 | 本地模型 id、显示名、可见范围、上下文/输出上限、Credit 单价、能力位（vision/tools/reasoning） | 管理动作，低频 |
| 后台模型绑定 | `upstreamModel` + 上游 `baseUrl`（固定指向 audit-proxy）+ `credentialId`（租户级 new-api 令牌，存 vault） | 运维动作，极低频 |
| new-api 渠道 | 供应商、真实模型名、渠道权重/故障切换、供应商侧定价 | 运维动作，低频 |

**模型目录以后台为准**：员工看到什么、能用什么，由后台决定；new-api 的渠道配置是"怎么到达上游"，不决定可见性。两者用 `upstreamModel` 对齐，后台 `probe` 只证明"上游 /models 可达"，不证明生成可用（保留 V1 的这个教训）。

### 5.2 凭据粒度：租户级令牌（决定）

**选定：每个租户一把 new-api 令牌，存后台 vault，客户端永远看不到。** 不选每员工一把，理由：

- 后台代理了全部请求，**员工级归因与额度本来就在后台账本**，数据面不需要再复制一份；
- 每员工令牌意味着后台要管理 N 把令牌的生命周期（创建/轮换/离职吊销），多一处会漂移的状态；
- 租户级令牌让 new-api 侧只能看到"某公司用了多少"，而这正是供应商对账需要的口径。

代价：new-api 控制台不再有员工级用量，现有按员工的巡检/报表要切到后台的用量接口（迁移项，不是新增系统）。审计侧用 `X-UWork-Member` 头补人；audit-proxy 已记录脱敏请求头，需确认报表可见性并补一个"按成员查正文"的入口。

### 5.3 降级与边界

- 后台不可用 → 登录/配置/模型全部不可用（客户端显示离线并保留最后一次可信状态），**不存在绕过后台的模型路径**。
- audit-proxy 不可用 → 后台模型调用失败（502），**不允许配置成直连 new-api**：跳过审计就是事故。
- new-api 不可用 → 模型调用失败；已分派的记为 uncertain，不自动重试。
- 自定义供应商：uwork 模式下由企业策略裁决（`/api/client/authorize` 的 `personal.models`），不是客户端本地开关；纯本地模式（跳过登录）仍可接自建供应商。**是否放开是管理动作，不是产品默认**。

## 6. 审计与计量

五类事实，五个所有者，靠 correlation id 关联，不互相复制：

| 事实 | 写入者 | 存储 | 保留 | 谁能看 | 关联键 |
| --- | --- | --- | --- | --- | --- |
| 模型请求/响应正文 | audit-proxy | 本地 `meta.db` + `blobs/`（去重、gzip）；超窗冷归档 NAS | 默认 90 天（可配） | 审计管理员（audit-proxy admin API/报表） | `X-UWork-Correlation`（待接线） |
| 模型用量与账本 | uwork_backend | SQLite（租户隔离） | 业务保留（账本不随留存清理删除） | 管理员（`/usage`、`/metrics`、CSV）、成员（本人 `/api/client/usage`） | ledger id ↔ correlation |
| 管理动作审计 | uwork_backend | SQLite | 同租户留存策略（7–3650 天） | read 权限管理员（`/audit`） | — |
| 客户端事件/Trace | uwork_backend | SQLite（加密工具参数/结果） | 同上 | 管理员（`/traces`、`/client-events`） | run id |
| 消息正文 | msgbus | 消息库 | 业务保留 | 会话成员；撤回后对外路径不再返回正文 | conversation/id |

**边界（写清楚，避免"以为都审计了"）**：

- 员工本地文件读写、终端命令：**不审计**（这是本地工具，不是企业服务）；工作痕迹同步是另一套设计，不在本文。
- 技能市场浏览/安装：**不审计**（匿名）。
- 配对口令：中继只存散列。
- 审计代理的正文与后台账本**不做实时强一致**：正文里有租户令牌（脱敏为 keyHash），后台账本里有成员与额度；两边按 correlation/时间窗对账，允许分钟级延迟。

管理台读什么：后台审计页看"谁改了什么、谁用了多少、工具做了什么"；模型正文查询仍由 audit-proxy 的报表承担（保留 V1 能力），后台只提供跳转与关联键，不复制正文。

## 7. 边界与网络分区

### 7.1 凭据

| 凭据 | 签发 | 用途 | 存放 | 生命周期 |
| --- | --- | --- | --- | --- |
| 企业会话令牌 | uwork_backend | 后台全部业务接口 + `/v1` 模型 | Host 加密存储，Renderer 不可见 | 服务端校验；过期/吊销即时生效 |
| 设备令牌 | uwork_backend | CLI/agent 自身调用后台 | `~/.uwork` 加密 | 最长 168h，可吊销，不能管理 |
| 上游 new-api 令牌 | 运维在 new-api 创建，存后台 vault | 后台 → audit-proxy → new-api | 仅服务端（AES-GCM） | 轮换由管理员操作 |
| IM 令牌 | uwork_backend 按共享密钥签发 | msgbus | 内存/首帧 | 短时（≤1h） |
| 配对口令 | 桌面生成 | 手机↔桌面 | 中继只存散列 | 刷新二维码即失效 |

### 7.2 网络区域（compose）

| 区域 | 成员 | 可达性 |
| --- | --- | --- |
| edge | nginx | 公网 443 |
| app | `uwork_backend`、`msgbus`、`relay`、旧 `control-plane` | 仅 edge 可达 |
| gateway | `audit-proxy` | 仅 app 区（backend）可达；旧装量经 nginx `llm.` |
| model | `new-api`、`postgres` | `internal: true`，无公网入口，仅 gateway 可达 |
| egress | new-api 的出站网络 | 只允许 new-api 出公网 |

硬规则：**new-api 不发布端口；audit-proxy 不接受新装量直连；后台不直连 model 区。**

### 7.3 组织边界

一个租户 = 一家公司 = 一个企微应用（corpId/agentId/secret）+ 一个后台租户。回调统一 `{backend}/api/auth/wecom/callback`，`state` 绑定 attempt；组织选择只决定扫哪家应用，不参与授权；所有跨租户 ID 一律 404，不泄露存在性。

## 8. 部署拓扑与运维

- **单机单实例**：`uwork_backend` 是 SQLite WAL 单写者，靠租约保证同一数据卷只有一个活实例；多副本必须先迁 PostgreSQL + 共享队列（不在本期）。
- **域名**：`uwork.<domain>` = 后台（管理 Web + API + `/v1` + 分享页）；`pivot.<domain>` = 旧控制面（迁移期保留）；`llm.<domain>` = 旧模型入口（迁移期保留）；`aihub.<domain>` = 内容源/中继页。
- **企微**：每家企微应用把回调域/可信域指向 `uwork.<domain>`（运维动作，需管理员权限）。
- **备份**：后台 `npm run backup`（在线 backup API）+ `MASTER_KEY` 独立受保护备份（丢了 vault 就解不开）；new-api Postgres 常规备份；audit-proxy 数据卷 + NAS 冷归档。
- **升级**：先备份 → 停旧实例 → 启新版本；schema 只升不降，回滚要连库快照一起回。

## 9. 容量与失败模式（必须先承认的）

| 项 | 现状 | 影响 | 处置 |
| --- | --- | --- | --- |
| 每组织并发上游调用 | 后台**硬编码 16**（`src/entitlements.ts`：按 `ledger.status='reserved'` 计数，超限 429 `CONCURRENCY_LIMIT`） | 大组织同时生成会排队；每次预留都做一次 count(*) | 试点按 20–50 人；先把它参数化并给 ledger 加索引，压测后再定值；再扩需迁 Postgres/拆分流式 |
| 后台在数据路径上 | Node 单进程，SSE 转发 | 成为吞吐上限与单点 | 先测量 p50/p95 与并发；不达标再考虑"边缘令牌交换"方案（见 §10） |
| 工具调用响应重组 | 完整后才转发 | 工具类响应首字节延迟高 | 保持；不在未落库前转发是正确性要求 |
| SQLite | 单写者 | 写并发受限；磁盘满即拒绝写 | 数据卷监控 + 备份；写失败一律 fail closed |
| 计量与正文解耦 | 两套存储 | 对账要按 correlation 关联 | 上线前补归因头落库与关联查询 |

## 10. 方案取舍（为什么不是别的）

**模型入口三选一**：

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| A 后台代理（选定） | 客户端 → 后台 `/v1` → audit-proxy → new-api | 无客户端 Key；策略/计量/撤权一处；复用后台已实现与已测的网关 | 多一跳，Node 成为吞吐上限；工具响应重组有延迟 | **一期采用**，容量达标前不放量 |
| B 边缘令牌交换 | 客户端持后台会话令牌直连 audit-proxy，代理换 new-api 令牌 | 不加跳，复用现网代理与报表 | 要改 audit-proxy 做验签/换票；策略与计量分散到两处；后台账本要改成读侧 | 作为 A 的扩容逃生口，仅在并发不达标时启用 |
| C 短时上游令牌 | 后台发 5 分钟 new-api 令牌给客户端 | 最简单 | 凭据又回到客户端；无法逐请求撤权 | 否决 |

**上游凭据粒度**：租户级（选定）vs 每员工一把——理由见 §5.2；每员工方案的唯一优势是 new-api 自带员工级报表，而我们有后台账本可以替代。

**审计放在哪**：继续用 audit-proxy（选定）vs 并在后台里写——后者要重做 DLP/护栏/缓存/NAS 归档，且会让"业务库"与"正文库"耦合；否决。

## 11. 迁移与并存

| 阶段 | 范围 | 验收（缺一不可） | 回滚 |
| --- | --- | --- | --- |
| P0 实验室 | 本机 compose：后台 + audit-proxy + new-api + msgbus | 合成身份登录；一次真实对话；账本 settled；audit 正文可查；correlation 能关联 | 删卷重来 |
| P1 单组织试点 | 一个租户、一个企微应用、20–50 人 | 真扫码；席位/限量生效；撤权即时阻断；DLP/护栏仍生效；后台与 new-api 用量对账差值在阈值内 | 发布配置去掉 `backend:uwork` 即回 ucas |
| P2 能力补齐 | 资产/策略/控制台；IM 令牌联邦；审计归因头 | 资产撤权、菜单发布、IM 登录、按成员查正文 | 按能力开关关闭 |
| P3 放量与收敛 | 其余组织；旧控制面退役评估 | 并发压测达标；备份恢复演练；旧入口下线计划 | 保留 `pivot/llm` 至最后一家迁完 |

并存规则：同一成员同一时间只用一条后端；两家后端共享 audit-proxy/new-api/msgbus，但**互不读取对方的身份与会话**。旧控制面的 `/api/keys` 只服务旧装量，不再新增发放。

## 12. 待确认

1. **审计归因头落库与查询**：audit-proxy 已记录脱敏请求头，但报表是否可按 `X-UWork-Member` 过滤、是否需要在 admin 侧加一个成员维度——需实测后决定改动量。
2. **correlation id**：后台注入、audit-proxy 原样留存，需要确认代理不改写请求头，并给后台账本加同名字段。
3. **IM 令牌联邦的密钥形式**：一期共享密钥（最小改动）；是否接受"后台与 msgbus 共享一个签名密钥"的安全评审。
4. **后台并发上限的目标值**：按试点实测再定，不先写死。
5. **旧控制面退役顺序**：`/api/keys`、`/api/usage`、`/api/auth/*` 的调用方清点（客户端旧分支 + 管理脚本）。
6. **企微回调域**：新增 `uwork.<domain>` 需要各企业管理员在企微后台加可信域/回调域。

## 附录 A：与 V1 的差异清单

| 项 | V1 | V2 |
| --- | --- | --- |
| 企业身份 | ucas control-plane | uwork_backend（旧装量并存） |
| 模型 Key | 控制面生成，客户端持有 | 不下发；租户级令牌在后台 vault |
| 模型入口 | 客户端 → `llm.` → audit-proxy | 客户端 → 后台 `/v1` → audit-proxy |
| 企业 MCP | 独立 mcp-gateway（仅内网） | 后台连接器代理（新装量）；mcp-gateway 只服务旧装量 |
| 资产/策略/控制台 | 无（V1 没有企业资产面） | uwork_backend 版本化分发与逐次裁决 |
| 用量 | new-api 员工级 | 后台账本（权威）+ new-api 租户级（对账） |
| IM/工作项 | 控制面同源 msgbus | 不变，改为信任后台签发的 JWT |
| 审计 | audit-proxy + 控制面管理审计 | 不变 + 归因头 + correlation 关联 |

## 附录 B：组件与代码位置

| 组件 | 位置 |
| --- | --- |
| 控制面 / 管理 Web | `uwork_backend`：`src/*.ts`（identity/directory/access/entitlements/gateway/assets/policy/runtime/telemetry）、`admin/` |
| 客户端适配 | `uwork_backend/clients/uwork` → 移植目标 `UWork-frontend`（见 `docs/integration/dev-system-integration-plan-2026-10-31.md`） |
| 审计代理 | `ucas-proxy/services/audit-proxy` |
| 上游网关 | `ucas-proxy`：`new-api` 容器 + `services/control-plane`（旧） |
| 消息/工作项/汇报 | `ucas-proxy/services/msgbus` |
| 中继 | `UWork-frontend/packages/relay` |
| 边缘 | `ucas-proxy/nginx/nginx.conf`、`docker-compose.yml` |
