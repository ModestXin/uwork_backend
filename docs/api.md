# 自有 API 合同

这是 UWork 自有协议，不是 WorkBuddy 私有服务端接口的复制。交互式路径索引：`GET /api/openapi.json`。其主要请求体由实际 Zod 合同生成；未附请求体的操作以本文、模块 SPEC 和 tests 为准。

## 鉴权与组织

- `POST /api/auth/login`：`{email,password,tenantId?,delivery?}`，`delivery="token"`（缺省）返回不透明 `token,expiresAt`；`delivery="cookie"` 只返回 `expiresAt`，会话仅经 HttpOnly/SameSite Cookie 交付，并要求请求 `Origin` 等于 `PUBLIC_URL`。管理 Web 不保存 token。
- `GET /api/auth/me`：当前成员、组织、角色、到期时间；`POST /api/auth/switch` 重新签发会话并废止旧会话。
- `POST /api/auth/logout`：可选 `{revokeDevices:true}` 同时废止当前成员在本组织的全部终端凭据。
- `POST /api/auth/device-tokens`：`{ttlHours:24,replaceId?}`，返回一次可见 `id,token,expiresAt`。只允许 execute，不允许管理/vault；最长 168 小时，默认 24 小时。GET 列元数据、DELETE `/:id` 吊销；创建/列表/管理吊销仅限交互会话，终端凭据只能退出自身。
- 每个 `/api/tenants/{tenantId}/...` 必须与会话组织一致。角色 owner/admin 可管理身份及 vault，operator 可管理非敏感业务资源，auditor 只读，member 仅执行。调用还要求有效席位、订阅、资源可见性和执行策略。
- Cookie 写请求必须带与 PUBLIC_URL 相同的 Origin；Bearer 客户端无需 Cookie。服务器不信任代理转发的 IP，IP 白名单使用 TCP 对端地址。

## 企微扫码

管理员：PUT `/api/tenants/{id}/wecom` `{corpId,agentId,credentialId}`，Secret 先存 vault；PUT `/members/{userId}/wecom` `{externalId}` 绑定现有成员，或 POST `/wecom/sync` 创建明确标记为 wecom 的成员（默认无席位、普通角色）。

1. POST `/api/auth/wecom/attempts` `{tenantId}` → `id,proof,expiresAt,authorizeUrl`。
2. 系统浏览器 GET `/api/auth/wecom/callback?state=...&code=...`；原生拦截回调时用 POST `/attempts/{id}/complete` `{proof,code}`。随机 state 与 attempt 绑定，proof 不放 URL。
3. POST `/attempts/{id}/claim` `{proof,delivery?}`。pending/verifying 继续轮询；`delivery="token"`（缺省）一次性返回 `status:"authorized"` 与会话，`delivery="cookie"` 返回 `status:"claimed"` 且只经 HttpOnly Cookie 交付，并同样要求同源 `Origin`。重复认领 409。
4. POST `/attempts/{id}/cancel` `{proof}`。验证中的取消也有效，迟到回调不能复活。

## 模型与计量

模型列表/创建/更新/停用：`/api/tenants/{id}/models`，创建和改变 URL/凭据关联需要 vault 权限。`/{modelId}/probe` 访问真实上游 `/models`，不把 HTTP 200 等同于模型生成可用。

```json
{
  "name": "Enterprise Model",
  "upstreamModel": "provider-model-id",
  "baseUrl": "https://provider.example/v1",
  "credentialId": "vault-resource-id",
  "contextWindow": 128000,
  "maxOutputTokens": 4096,
  "inputRate": 1000,
  "outputRate": 1000,
  "supportsVision": false,
  "supportsReasoning": false,
  "supportsTools": false,
  "scope": { "all": true },
  "enabled": true
}
```

更新需要完整内容与 `revision`；旧 revision 返回 409。`GET /v1/models` 只返回本成员当前可用模型。`POST /v1/chat/completions` 使用本地模型 id，支持文本、SSE、可选 reasoning_effort，以及显式启用的 data URL 图片；不下载任意图片 URL。上游协议是 OpenAI-compatible；其他厂商专属签名协议未适配。

Function tools 需模型显式启用 `supportsTools=true`。请求支持最多 64 个 `{type:"function",function:{name,description?,parameters,strict?}}`，`tool_choice` 为 auto/none/required 或指定 function，`parallel_tool_calls=false` 要求最多一个返回调用。assistant 消息可带最多 32 个 `{id,type:"function",function:{name,arguments}}`，tool 消息必须带 `tool_call_id` 与字符串内容。参数字符串必须为 JSON 对象；定义 schema 限 100 KiB、20 层及 10000 节点。

JSON/SSE 均保留 function name、call id 与参数；SSE 的工具片段先重组，完整协议、计量、结算和幂等结果持久化成功后才转发，不能在尚未确认成功时提前分派副作用。未知函数、重复 ID、缺失片段、非法参数、违反指定函数/禁止并行合同均返回明确错误，已可能计费的失败保留 uncertain。工具定义、历史调用参数和工具结果计入输入上界。网关只是协议和计量代理，不在此接口执行工具；Agent SDK 执行闭环另行验收。这是 Chat Completions 合同，不宣称已适配 Responses 专属模型。

Header `Idempotency-Key` 最长 128 字符；同键/同人/同内容且当前授权仍有效时重放成功结果，同键不同内容或处理中返回 409。成功缓存加密存储。输入按 UTF-8 字节及消息开销上界预留，输出按 max_tokens 预留，按真实 usage 结算；无 usage 时保守估算。每模型整数单价为每 1000 token 的 Credit，**Credit 不是美元或供应商账单**。

已输出、超时、取消、连接异常或进程重启不能证明上游免费，账本变为 `uncertain` 并占用全部预留额度。DNS 失败、解析前/中取消等未到实际分派边界的失败释放预留；已有合法 usage 的调用即使因完成前撤权拒绝输出，仍按 usage 结算。分派前、每个 SSE 文本片段与完整响应成功前重查成员/会话/席位/订阅/模型/出口策略/凭据；已发送片段无法收回。管理员 PUT `/api/tenants/{id}/usage/{ledgerId}/reconcile` `{amount,evidenceReference}` 在预留范围内核实，一次性审计。成员/部门祖先/应用/企业限制在同一个 SQLite 事务内检查，组织最多 16 个并发上游调用。

`/subscription` 管理本地席位与订阅，`/limits` 维护 tenant/member/department/application 限量；自然月或订阅周年切片均使用 UTC，月末周年按当月最后一天夹取，不删除历史账本。

## 资产与策略

- `/assets` 支持 skill/expert/connector/playbook/instruction，内容严格按类型校验；技能为包含 SKILL.md 的安全相对路径文本文件包，单包最多 1 MiB。不是任意压缩包解压执行器。`supportedClients` 缺省按类型取值：skill/expert/connector 为 `uwork`+`agent`，playbook/instruction 仅 `agent`（控制台证据：自定义指令页对 WorkBuddy 标注“暂不支持”，Playbook 页只读 Cookbook、无创建/上传请求）；显式声明 `uwork` 返回 400 `CLIENT_UNSUPPORTED`。
- 每次更新新增不可变版本；`/{id}/review` `{version,approved}`，`/{id}/publish` `{version}`；审核拒绝当前发布版本会撤下。`/categories` 维护分类。
- `/policies` 支持 allow/deny/distribute，作用域为成员/部门/全员；先默认可见范围，allow 取交集，deny 优先。连接器遵循同样规则。
- `/policies/security` 采用最大数字优先级的完整规则，不合并多个命中策略。
- `/configurations/{kind}` 的 kind 为 menus/new-chat/assistants/sharing/personal/security/network；PUT `{revision,data}` 只存草稿，POST `/publish` `{revision}` 才生效；DELETE `/draft` 放弃草稿。已发布快照有独立递增版本与历史。
- `/api/client/configuration`（ETag）、`/assets`、`/assets/{id}/download`、`/authorize`、`/events` 为终端合同。撤权后下载/执行即时拒绝；获取快照不等于本地 Host 已执行所有策略。
- `POST /api/client/authorize` 先验证有效订阅/席位/IP 和 `channel`（local/agents/cloud，缺省 local）。`action=execution` 返回当前 `{allowed:true,tenantId,security,personal}`，其中 personal 只含已发布 models/skills/connectors 布尔值，不包含 MCP Hub 地址；它与 security 来自同一次同步裁决，不能拼接两次 HTTP 的旧策略。该动作仅确认执行上下文，不授予任意资源权限；可信 Host 再按实际能力、最终输入和每次 HTTP 目标执行裁决。其余 asset/shell/filesystem/network 动作保留原合同。新受管技能 Host 要求 personal 字段；先升级后端再更新该消费者，缺失明确拒绝、不回退旧允许。
- `action=asset` 必须携带 target（资产 ID）、assetVersion 与 64 位小写十六进制 assetChecksum；仅当前已审核发布/可见/支持 UWork 且绑定一致时允许，高风险技能还检查 dangerousSkills。它不授予 shell/filesystem/network。资产列表/下载也检查有效订阅、席位和 IP；下载可用 `?version=N` 绑定清单版本，已换版返回 409 ASSET_VERSION_CHANGED，不静默返回另一个版本。非连接器响应增加 kind 并保留内容 checksum；连接器仍只有 masked 内容及代理路径。
- `action=share` 同时返回当前 `sharing`（publish/collaborate/files/wechat/wecom）及已有 security；新 Host 使用同一裁决检查实际 HTTP 目标和文件事实。公网“私有链接”仍以 `target=internet` 裁决，不冒充组织隔离。
- 内置菜单保留，自建地址 HTTPS；AI 风险前缀固定；历史全局提示词不注入。IP 空列表允许，**单独 127.0.0.1 是产品兼容的禁止全部标志**。

连接器 RPC：POST `/api/client/connectors/{id}/rpc`，仅允许声明方法与 `allowedTools`。initialize 返回本地不透明 MCP-Session-Id；远端 session 加密并绑定成员、资源发布版本和有效期。凭据只由代理注入，响应中的凭据/远端 session 回显脱敏，顶层非 JSON-RPC 协议字段剥离。支持 POST JSON 与单次 SSE 响应；不提供长期服务端推送 GET 流。请求分派前重新检查成员、终端凭据范围/有效期、发布版本、安全出口；DNS 等待也受取消和截止点约束。DELETE 同一路径配合 `mcp-session-id` 显式回收会话（204，只作用于当前凭证持有者的会话），不需要等到自然过期。

连接器协议版本：`initialize` 按客户端 `params.protocolVersion` 选择发往远端的 `mcp-protocol-version`，并把远端协商结果记录在该连接上；后续请求回放该连接的版本，请求体里的版本不能改写已建立的连接。缺少有效版本时回退 `2025-03-26`。

## 企业内会话分享

访问模式 `organization`：只有发布者当前企业的有效登录成员可只读查看；分享 URL 不是访问凭据，凭 share code 不能匿名读取或导入。存储、授权与限额合同见 [SPEC-enterprise-sharing.md](../SPEC-enterprise-sharing.md)，实现见 `src/sharing.ts`、`src/sharing-viewer.ts`，真实 HTTP 闭环见 `scripts/client-organization-sharing-live-smoke.ts`。

- `GET /api/client/shares/capabilities`：当前发布能力，`access_modes=["organization"]` 及上限（1 MiB 确认体/2,000 行/8 附件/512 KiB 单附件/1 MiB 附件合计/10 分钟准备/7 天分享）；`publish=disabled` 或 `files=false` 时分别拒绝或清空附件能力。要求 execute、有效订阅、local 渠道与当前 sharing 策略。
- `POST /api/client/shares/preparations` `{client_request_id,title,schema_version:1,access_mode,payload_sha256,artifact_count}` → 201（同键同内容重放 200，异内容 409）。`POST /preparations/{id}/artifacts` `{descriptor,content_base64}` 校验实际字节/长度/SHA；`POST /preparations/{id}/confirm` 校验所选轮次、完整投影、披露确认与投影/附件集合摘要后原子发布。附件仅 text/txt、md/md、image/png、image/jpg|jpeg、pdf/pdf，字节存数据库 BLOB，不用上传名称落盘，也不代客户端抓取 URL。
- `GET /api/client/shares/{code}/preview`：实时成员授权后返回只读投影、`can_revoke` 提示与同源、仍需身份验证的附件 URL。`GET .../artifacts/{id}` 为 Host 私有 JSON（有限 base64）；`GET .../artifacts/{id}/content` 为浏览器同源 Cookie 下载，强制 `attachment`、`application/octet-stream` 与 `nosniff`。
- `DELETE /api/client/shares/{code}`：发布者本人或同企业 write 角色撤销（幂等 204）；撤销后正文与附件均不可读。`POST /api/client/shares/{code}/continuation` 恒为 403 `SHARE_READONLY`，不创建导入 grant。
- `GET /share/{code}`、`GET /cn/share/{code}`：自有同源只读浏览页（CSP `default-src 'none'`），未认证时只显示登录入口；`GET /api/auth/shares/{code}/context` 仅提供完成企微认证所需的公开企业定位。

跨企业或无权访问的 opaque ID 一律 404 且不泄露标题、作者、正文或附件名；未登录 401。查看只要求当前有效登录成员与 IP 规则，不要求模型席位，也不预留或扣减模型额度。

## 手机远控（免扫码通路）

企微内置浏览器从工作台进入时，不再靠扫桌面二维码拿配对材料，改为"设备目录 + 配对应答"：

- `PUT /api/client/remote-devices/:sid`（桌面，Bearer）：登记设备存在 `{deviceMid,name?,platform?,ttlSeconds?}`（默认 120s，最大 600s，幂等心跳）。**不存任何密钥**。
- `DELETE /api/client/remote-devices/:sid`：注销；同时作废该设备未完成的配对请求。
- `GET /api/client/remote-devices`：只列本人 TTL 内设备，**不含密钥**；跨成员不可见。
- `POST /api/client/remote-devices/:sid/pairings` → `{id,expiresAt}`（≤60s）；同一设备只保留一条待应答请求。
- `GET /api/client/remote-devices/:sid/pairings/:id` → `pending | expired | answered`；`answered` 时返回 `{sid,hash,org,enterpriseAuth}` 并**立即消费**（一次性）。
- `GET /api/client/remote-pairings/next?deviceSid=&wait=`（桌面，长轮询 ≤30s）→ 待应答请求或 `null`。
- `POST /api/client/remote-pairings/:id/answer`（桌面）`{sid,hash}` → 材料只留在进程内 Map（TTL、一次性），不落库。

准入这批只要求有效会话 + 席位 + IP 白名单（复用既有判定）；菜单开关、`remote` 渠道、审计与人工对账留下一批。relay/协议不变：手机拿到 `{sid,hash}` 后仍走既有 HMAC 连接与企业身份帧。

同源入口：`GET /api/auth/wecom/web-config`（公开）按请求 Host 解析组织并回 `{backend:"uwork",tenantId}`，供手机页与后台同源时自动定位（企微应用主页不需要任何参数）；Host 映射用 `TENANT_HOSTS="host=tenantId,…"` 配置，解析顺序为映射 → 唯一已配置租户 → 唯一租户，解析不出就 404/400 `TENANT_REQUIRED`。`POST /api/auth/wecom/attempts` 的 `tenantId` 因此变为可选（省略时按同一规则解析）。

企微网页授权：`POST /api/auth/wecom/attempts` 增加 `mode:"qr"|"web"`（默认 `qr`）。`web` 时授权链接为 OAuth2 网页授权（`scope=snsapi_base`、`redirect_uri=returnTo`），供企微内置浏览器免扫码登录；`returnTo` 只接受 HTTPS（本机回环 HTTP），扫码/回调/state 绑定与 `provider.identity` 复用既有实现。

## 企业客户端控制台

`POST /api/client/menus/{id}/authorize` 返回 `{allowed,tenantId,menu?,version}`；只读取当前已发布且启用的项，关闭/缺失项不返回 URL，chat/agents 均按既有本地入口检查 local 助理渠道；兼容菜单 ID agents/assets 分别映射现有自动化/插件商店。菜单只控制入口，助理/资源策略仍裁决实际执行。

`GET /api/client/agents` 只返回当前成员可见、已发布且启用的 `{id,name,publishedVersion}`，不返回 Agent 指令或供应商配置。`GET /api/client/runs` 按 page/pageSize 分页且仅查询本人；`POST /api/client/runs` 接受 `{agentId,input,timeoutMs?,sessionId?}` 并返回 202 任务 DTO。`GET /api/client/runs/{id}` 返回本人任务的 input/output/status/errorCode，跨成员或跨组织均 404。`POST /api/client/runs/{id}/cancel` 返回 `{ok:true}`，菜单关闭后仍可停止本人已有任务。上述接口检查当前席位、订阅和 IP；创建与读取另检查独立 agents 执行渠道，与本地自动化菜单启停脱钩；状态和队列完全复用 Runtime。

## Runtime 与观测

- `/agents` 创建/更新/发布；运行锁定发布版本。无工具资产且 sandbox=false 时为 model-only；`sandbox:true` 开启 SDK 隔离代码工具循环，同时要求模型 supportsTools、企业 allowSandbox、有效席位/订阅与助理 agents 渠道。配置 `maxTurns:1..20`、`maxToolCalls:1..20`、`toolTimeoutMs:100..60000`。每轮模型调用都由自有 Gateway 授权/预留/结算，禁 SDK tracing/exporter 与自动重试，不运行宿主 shell。
- `assetIds` 中已批准且支持 agent 的 connector 自动提供受控 MCP 工具，不需要开启代码沙箱。固定 MCP Client 2.3.1，经共享 ConnectorService/safeRequest 访问，协议为 2025-03-26 POST JSON/SSE；没有自由网络客户端、stdio 子进程、OAuth 自动注册或服务端采样。只暴露 allowedTools 与工具清单交集，以固定 `mcp_<hash>` 名称绑定资产/版本/远端名称；每次运行冻结版本，撤权、换版本、订阅过期均阻止后续分派。MCP 使用 agents 渠道，客户端代理使用 local 渠道。
- MCP schema/响应/参数均有体积与结构上限；输入通过 JSON Schema 校验，结果最多 32 KiB。受控 schema 不支持 pattern/patternProperties、引用和 uniqueItems，发现时明确 MCP_TOOL_SCHEMA，避免上游引入无界正则/递归/二次复杂度校验。单次发现和调用均受 toolTimeoutMs 与父截止点约束，最多 63 个 MCP 工具，不自动重连/重试副作用。
- POST `/runs` `{agentId,input,sessionId?,timeoutMs?}` → 202；GET 列表/详情，POST `/{id}/cancel`。queued/running/succeeded/failed/cancelled/timed_out 均持久化；最长 30 分钟，重启中断任务为 failed/PROCESS_RESTARTED。
- running 取消先持久化 cancel_requested，等待实际模型/工具结束及沙箱清理确认才返回终态；代码单次超时和总运行超时均为 timed_out。Docker 停止/移除未确认时父运行 failed/STOP_UNCONFIRMED，相关工具 uncertain，不能视为已停止或无副作用。角色撤销、模型/资产/安全策略变化在每次 provision、enqueue、执行和模型调用复核，活跃任务也由工作器复核取消。
- MCP 分派前持久化 dispatched 标记；发出后取消、超时、断线、无合法结果均为工具 uncertain、父运行 failed/REMOTE_EFFECT_UNCONFIRMED，不声称远端已停止或回滚。远端已确认结果可保存并去重；重启不重放，未确认工具保留 uncertain/PROCESS_RESTARTED。本地 MCP session 在结束/恢复时释放，远端 session 的过期/资源回收由服务商负责，未实现 DELETE 终止或远端停止确认。
- GET `/runs/{id}/tools`：仅本人或有 read 权限管理员访问工具记录，参数和结果在存储时加密。run/callId 唯一、参数指纹防冲突、队列与 executionId 原子绑定；已成功的相同调用可回放结果，不重新执行，处理中/失败/未确认调用拒绝重新分派。工具输出回传模型最多 32 KiB，完整受限输出仍保存在原执行记录。按 run 创建的沙箱只授权该成员，拒绝独立执行接口注入，运行结束/取消/崩溃恢复时回收。
- `/automations` 支持 once/interval/cron（含秒、显式时区），生效至 endsAt；持久化唯一触发键，禁止重叠，不重放离线期间每个历史时点。Webhook 凭据内容为 `{url,token?,type:webhook|feishu}`；最多 3 次投递，at-least-once，接收方用 run id 去重。
- `/datasets` 的样本为 `{input,expected,match:exact|contains}`；POST `/evaluations` 创建真实运行，GET 报告、POST `/{id}/cancel`；不把字符串匹配评分冒充 AI 评审质量分。
- GET `/runtimes/capability` 报告实际专用 Docker 镜像可用性及限制；未配置不可声称可执行。POST `/runtimes` `{name,scope?,ttlMinutes:1..30}` 创建非 root、无网络、无宿主挂载的真实容器，省略范围只授权创建者；GET 列表/详情，PATCH `/{id}` `{name,scope,revision}`，POST `/{id}/stop`，DELETE `/{id}`。每租户最多 4 个，全实例最多 16 个。停止/删除串行化，迟到 provision/inspect/reaper 不能复活已删除记录。
- POST `/runtimes/{id}/executions` `{code,timeoutMs:100..1800000}` → 202 `{id}`，只接受容器内 Node.js 代码；代码和输出加密保存。GET `/sandbox-executions` 支持 page/pageSize/runtimeId/status，GET `/{id}` 返回本成员或有 read 权限管理员可访问的解密内容，POST `/{id}/cancel`。执行需有效席位/订阅、助理 agents 渠道、Runtime 范围与安全策略 `allowSandbox=true`；默认关闭。即使允许网络，沙箱本身仍无网络。
- 一次 Runtime 同时只执行一个任务，工作器并发 4；输出总计上限 128 KiB。取消、超时、输出超限停止整个容器；崩溃恢复会实际停止中断代码进程并记录 failed/PROCESS_RESTARTED。TTL watchdog 与代码执行 UID 分离，最多 30 分钟。临时工作目录只能在该容器存活期间复用，不是持久网盘。
- `/audit`、`/traces`、`/usage`、`/client-events` 支持 page/pageSize/q/from/to/userId；trace/usage 另支持 application/status。`format=csv` 上限 10000 条，CSV 防公式注入，使用时间范围分段导出。
- `/metrics`、`/usage/aggregates?groupBy=member|department|application` 聚合自有账本；用量聚合只统计 settled 项，并与明细使用相同 from/to/userId/application/q（模型）/status 筛选，状态过滤不会扩大到非结算项。成员 `/api/client/usage` 仅看自己的统计，Credit 单位明确。
- 路由不变量（`tests/route-invariants.test.ts` 静态检查）：业务路由必须认证并判定权限（公开入口只在测试里显式登记）；带 `:tenantId` 的路由只能用登录态的组织，参数里的 tenantId 必须经 `tenantAccess` 校验；客户端/网关入口必须绑定当前组织的 tenant 并做执行权限判定。
- 审计不变量（`tests/audit-coverage.test.ts`）：所有改状态的管理端端点都写入审计事实；审计写在被调用服务内部的端点（`runs` 入队/取消、企微通讯录同步）显式登记，客户端入口按终端事件与账本记录、不写管理审计。
- GET/PUT `/retention`：读取/设置企业留存天数（7–3650 天，仅管理角色；未配置时返回默认 90 与 `configured:false`）。POST `/retention/purge` 未显式给出 `days` 时按企业配置执行，显式天数仍可覆盖本次清理；后台每小时只清理显式配置过留存的企业。清理诊断记录、临时缓存和可删除终态任务；业务账本、评测、自动化历史按业务保留，需按企业要求补充归档策略。

## 外部适配

`/integrations` 声明能力状态。网盘经自有 HTTPS 适配网关提供 health/capacity/files/logs 及容量策略，不直接宣称已实现腾讯网盘私有协议。缺少配置返回 503。支付仍 unavailable；隔离 Docker 沙箱仅在实际 daemon 和配置镜像检查通过时报告可用，不代表外部云供应商服务。
