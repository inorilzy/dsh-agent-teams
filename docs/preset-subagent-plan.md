# 预设 Subagent 委派工具调研与实现方案

本文整理针对「主 Agent 启动普通 Subagent 时按预设指定角色与模型」的调研结论与最小集成方案，供后续直接实现。

- **代码基线**：`dsh-agent-teams` `0.19.3`（`15c5bbc`）
- **目标宿主**：DSH `0.2.2-rc.2+`（已按 `@deepseek-ai/dsh-subagent@0.2.2-rc.5` 类型定义核实）
- **已确认前提**：**直接采用 DSH `0.2.2-rc.x` 新版扁平 `startActivation` API**，不保留 `0.2.1-rc.x` 的 `spec.request` 旧包装兼容；同步迁移现有 DAG worker 的 `launch()`。

---

## 1. 需求背景与宿主现状

当前 `dsh-agent-teams` 已经在插件配置中提供完整的 `agents` 预设（`architect`、`debugger`、`implementer`、`frontend`、`scribe`、`verifier` 及用户自定义预设），每个预设同时绑定：

- 展示信息：`name`、`description`
- 角色指令：`instructions`
- 模型路由：`provider`、`model`、`reasoningEffort`
- 并发控制：`maxConcurrent`

但目前这些预设**只在 `dag_run` 派发工单 worker 时生效**。日常对话中主 Agent 启动普通 `subagent` 时，只能走宿主自带工具。

### 宿主 `@deepseek-ai/dsh-tool-subagent` 能力边界

| 能力 | 宿主现状 | 缺口 |
|---|---|---|
| `agentOptions` | 仅支持在工具实例配置中写死单个固定路由（绕过会话白名单） | 无法按角色动态选预设 |
| `agentPreset` / `allowedAgentPresets` | 模型可通过 `agent_preset` 枚举选宿主预设 | 宿主的「Agent Preset」指工具/提示词/技能组合，**不含模型路由** |
| `modelSelectionSettings` | 会话创建时捕获 `allowedModels` 白名单，暴露 `provider`/`model`/`reasoning_effort` 参数 | 需要主 Agent 自己选模型、自己拼角色指令，且改设置对已有会话不生效 |

**结论**：宿主没有「一个预设名同时绑定角色指令与模型路由」的机制，但暴露了底层 `ctx.subagents.startActivation`，正好适合在 `dsh-agent-teams` 中新增一个轻量工具复用现有 `config.agents`。

### DSH `0.2.2-rc.2+` 新版 `startActivation` 契约

核实来源：`@deepseek-ai/dsh-subagent@0.2.2-rc.5`（`lib/types/types.d.ts`）。

- **破坏性变更**：自 `0.2.2-rc.2` 起，移除 `spec.request` 包装层，`prompt`、`parent`、`cwd`、`agentOptions`、`agentPreset`、`maxDepth`、`outputSchema` 全部扁平化到 `SubagentActivationSpec` 顶层。继续传 `{ request: { ... } }` 会在宿主直接抛出 `Cannot read properties of undefined (reading 'id')`。
- **扁平入参**：
  ```ts
  {
    provider: 'spawn' | 'fork',         // 传输后端
    label: string,                      // 会话列表与回执展示标签
    name?: string,                      // 可选短名：1-32 位小写字母/数字/短横线，字母开头，非 lead
    childId?: SessionId,                // 仅本地后端预约 ID 时传（普通委派可省略）
    parent: Agent,                      // 发起委派的父 Agent
    cwd?: string,                       // 相对或绝对路径，省略继承父目录
    prompt: ContentBlock[],             // [{ type: 'text', text }]（非 string）
    agentOptions?: {
      provider?: string,
      model?: string,
      reasoningEffort?: string,
      maxTokens?: number,
    },
    maxDepth?: number,                  // 委派深度上限，如 1 表示禁止孙代再派
    signal: AbortSignal,                // 必填，仅控制发布前取消
    delivery: 'parent' | 'caller',      // 必填：'parent' 由宿主推送完成通知并入会话树；'caller' 仅返回给调用方 await
  }
  ```
- **返回值 `SubagentActivation`**：`{ childId, name, messageId?, result: Promise<SubagentResult>, dispose() }`。取消运行中的子代理只能通过 `activation.dispose()`；对于 `delivery: 'parent'` 的普通子代理，宿主会将其纳入父会话子代理目录，直接支持原生 `list_agents`、`send_message` 与 `interrupt_agent`。

---

## 2. 生态与竞品调研汇总

### 2.1 DSH 插件市场同类插件（排查 14 个，精选 8 个核心方案）

| 插件（核实版本） | 定位 | 0.2.2 扁平 API | 亮点 | 短板 / 不适合直接照搬之处 |
|---|---|---|---|---|
| `dsh-subagent-library` (0.4.0) | 角色名册 + 编队库 | 是（0.2.2-rc.5） | 扁平 `startActivation(delivery: 'parent')`；label 与回执带 `[model · effort]`；支持默认路由与单次覆盖；明确移除脆弱的 `toolFilter` | 自带 YAML 目录、编队、`/subagent` 命令，体量偏重；裸工具名 `delegate`/`list_subagents` 易撞名 |
| `dsh-plugin-subagent-director` (0.7.0) | 角色模板 + 默认模型 + 纯编排模式 | 是（>=0.2.2-rc.2） | 四级回退（入参 > 角色 > 默认 > 继承）；支持按 `displayName` 兜底匹配；补了真实 `SubagentRuntime.startActivation` 契约测试 | 强绑定宿主 `allowedModels`；自维护 `close_subagent` 收据表与 `/orchestrate` 模式 |
| `dsh-agent-studio` (0.2.3) | 图形化 Agent 配置台 | 是（>=0.2.2-rc.2） | **工具名加前缀防碰撞**（裸名撞车会让 `tools.register` 抛错并连带毁掉插件）；扁平 spec 注释清晰 | 自建整套配置台、提示词/工具面装配与会话映射表，过重 |
| `dsh-submodel` (0.4.2) | 强主脑 / 便宜执行双向路由策略 | 是（>=0.2.2-rc.5） | 按主模型自动判档；硬隔离防止子代理递归转包；组内失败自动顺序换模 | 面向「性价比 vs 专家」两档模型，非通用角色预设 |
| `dsh-subagent-hub` (0.14.0) | 命名角色 + 路由守卫 + 监控总览 | 复用原生 `subagent` | 注册宿主 `hub-agent-<id>` preset 并同步白名单；按角色限定路由范围 | 深度耦合宿主设置同步与侧栏监控，复杂度高 |
| `dsh-subagent-profile` (0.5.1) | 方案派发 + 成本账本 + 演化建议 | 旧版（0.1~0.2.0） | 「请求 vs 实际生效」决策账本、成本估算与安全门禁 | 依赖旧 `dsh-jobs` 与黑盒工具集收窄，落后于 0.2.2 |
| `dsh-subagent-setup` (0.2.2) | 别名路由（本地 JSON） | 是 | 轻量化，按别名映射模型与默认思考档 | 仅做模型别名，不含角色指令 |
| `oh-my-dsh-slim` (0.8.10) / `dsh-subagent-plus` (0.0.4) | 专家分工 preset / 路由策略与故障切换 | 未切扁平 API | 角色分工清晰；轮询/优先级/健康检查 failover | 前者每角色注册一个工具导致上下文膨胀；后者故障切换对首版偏重 |

### 2.2 主流 CLI Agent 内建子代理预设

调研了 Claude Code、OpenCode (V2)、Gemini CLI、Qwen Code、Copilot / VS Code、Roo Code、Kilo Code、Factory Droid、Amp、Codex CLI、Cursor 共 11 个工具，核心共性与踩坑：

- **最普遍的坑：预设里配的模型被静默忽略、悄悄退回父模型**。Claude Code（[#52681](https://github.com/anthropics/claude-code/issues/52681)、[#31311](https://github.com/anthropics/claude-code/issues/31311)）、OpenCode（[#49765](https://github.com/anomalyco/opencode/issues/49765)、[#50925](https://github.com/anomalyco/opencode/issues/50925)）、Codex（[#26363](https://github.com/openai/codex/issues/26363)）、Gemini CLI（[#26146](https://github.com/google-gemini/gemini-cli/issues/26146)）、Copilot（[discussion #191450](https://github.com/orgs/community/discussions/191450)）均出现过同类缺陷。
- **最佳失败策略（Factory Droid / VS Code `model-policy: required`）**：预设绑定的模型不可用时，先试配置好的 fallback（若无则直接报错、不启动），**绝不静默退回父模型**。
- **上下文控制**：单一工具 + 预设名参数远优于「每预设一个工具」（Gemini CLI 早期做法）；Claude Code 对全部自定义 subagent 描述超过 15k tokens 发启动警告，建议列表仅留一行「何时使用」，长指令放正文。
- **递归与权限**：默认限死嵌套深度（Codex `max_depth=1`，Gemini/Factory 禁止子代再派）；VS Code 文档明确指出「写在提示词里的只读要求不是权限边界」。

### 2.3 第三方编排插件与 MCP

调研了 oh-my-openagent (OmO)、Paseo、PAL MCP (clink)、claude-code-router (CCR)、codex-subagents-mcp、`codex mcp-server`：

- **只传 preset 名，不让编排模型手拼路由字符串**：OmO 采用「主模型选类别/角色，服务端解析 model/effort/fallback」。相反，Paseo（[#7158](https://github.com/getpaseo/paseo/issues/7158)）让编排模型手拼 provider 字符串，导致格式错配且错误未透传。
- **避免两条解析路径**：OmO（[#1347](https://github.com/code-yeongyu/oh-my-openagent/issues/1347)）曾出现 `subagent_type` 路径忽略 model 而 `category` 路径生效的问题。
- **显式暴露实际运行的模型**：OmO（[#2571 / PR#2575](https://github.com/code-yeongyu/oh-my-openagent/pull/2575)）因静默路由到高成本模型且无轮数上限造成大额费用，修复方案之一就是在结果中明确标出实际使用的模型。
- **不用 prompt 标签做路由信号**：CCR 依赖模型在 prompt 开头写 `<CCR-SUBAGENT-MODEL>` 标签，存在模型漏写/写错风险。

---

## 3. 去其糟粕，取其精华

### 采纳（纳入本次实现）

1. **单一工具 + 预设 ID**：主 Agent 只传预设 ID（如 `architect`），由插件从 `config.agents` 统一解析 `instructions`、`provider`、`model`、`reasoningEffort`（单一路径，杜绝双路径分叉）。
2. **工具名带插件前缀**：避免使用裸名 `delegate` / `list_subagents`，防止与市场其他插件冲突导致注册失败（借鉴 `dsh-agent-studio`）。
3. **直连 0.2.2 扁平 `startActivation(..., delivery: 'parent')`**：完全复用宿主原生完成通知、会话树、`list_agents`、`send_message`、`interrupt_agent`（借鉴 `dsh-subagent-library`）。
4. **启动前强校验、绝不静默降级**：直接复用现有 `validateTicketRoutes`（`src/dashboard.mjs:588`）校验预设绑定的模型目录与思考档位；配置无效时明确抛错，仅当预设未配模型时显式继承父会话（借鉴 Factory Droid）。
5. **路由完全可见**：`label` 与工具返回 JSON 同时写出实际生效的 `preset`、`provider`、`model`、`reasoningEffort` 及是否继承（借鉴 `dsh-subagent-library`、OmO PR#2575）。
6. **轻描述 + 默认防递归**：工具描述仅列每个预设的一行简介（含绑定模型或「继承父会话」），长 `instructions` 在派发时拼入首条消息；默认 `maxDepth: 1` 禁止无限套娃（借鉴 Claude Code、Codex、`dsh-submodel`）。

### 明确不做（保持最小化）

- 不为每个预设注册单独工具。
- 不新建配置文件、独立设置页或编队机制，完全复用现有 `config.agents` 与「Agent 预设」配置页。
- 不做黑盒工具过滤（`toolFilter`）或伪权限提示词。
- 不做自研 `close_subagent`、成本账本、健康检查自动故障切换（后续若确有需要，再在预设上增量加 `fallback` 字段）。

---

## 4. 集成到 `dsh-agent-teams` 的最小实现方案

### 4.1 复用现有配置

完全复用 `src/index.mjs` 现有的 `Config.agents` 与 `src/agents.mjs` 的 `builtinAgents`：

```js
// 现有结构，零破坏性改动
agents: {
  [id]: {
    name,            // 显示名，如 '架构'
    description,     // 一行用途描述（展示在工具描述中）
    instructions,    // 角色提示词（派发时注入子代理首条消息）
    provider,        // 空串表示未指定
    model,           // 空串表示继承父会话模型
    reasoningEffort, // 空串表示使用模型默认
    maxConcurrent,   // 0–32（0 表示不限）
  }
}
```

### 4.2 新增工具设计

暂定工具名：**`preset_subagent`**（或 `dag_subagent`，待开工前二选一）。

#### 参数定义

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `preset` | `string` | 是 | `config.agents` 中定义的预设 ID（如 `architect`、`debugger`、`implementer`、`frontend`、`scribe`、`verifier` 或自定义 ID） |
| `description` | `string` | 是 | 3–5 词简短任务描述，用于会话列表标签 |
| `prompt` | `string` | 是 | 自包含的任务说明 |
| `cwd` | `string` | 否 | 子代理初始工作目录（相对路径基于父会话当前目录解析），省略则继承 |
| `name` | `string` | 否 | 可读短名（1–32 位小写字母/数字/短横线，字母开头，非 `lead`），便于 `send_message` 续聊 |

> 工具的 `description` 动态列出当前 `config.agents` 中各预设的一行摘要，格式如：
> `- architect (架构) [provider/model · high]: 架构（建议高智力模型）：先定下游共用的接口、骨架与共享注册点`
> 若模型为空则标注 `[inherit]`。动态生成（或随系统提示更新），确保设置页改完预设后主 Agent 立即可见最新列表。

#### 执行流程

```js
// 1. 守卫：插件未停止，存在调用方 exec.agent
if (closing) throw new Error('Agent Teams plugin is stopping')
const parent = exec.agent
if (!parent) throw new Error('Requires a live calling agent')

// 2. 读取最新配置并解析 preset（支持精确 ID；未命中时报错并列出可用 ID，可选提示 displayName 匹配项）
const current = settings()
const agents = current.agents ?? {}
const spec = agents[args.preset]
if (!spec) {
  throw new Error(`Unknown agent preset "${args.preset}". Available: ${Object.keys(agents).join(', ')}`)
}

// 3. 路由校验：复用 src/dashboard.mjs 的 validateTicketRoutes
//    - provider / reasoningEffort 填了但 model 为空 -> 抛错
//    - model 非空 -> 校验 provider/model/reasoningEffort 存在于当前模型目录，不存在直接抛错（绝不静默降级）
//    - model 为空 -> agentOptions 省略，显式继承父会话路由
const provider = String(spec.provider ?? '').trim()
const model = String(spec.model ?? '').trim()
const reasoningEffort = String(spec.reasoningEffort ?? '').trim()
await validateTicketRoutes(
  [{ id: args.preset, agentSpec: { provider, model, reasoningEffort } }],
  () => ctx.get('llm'),
)
const agentOptions = model
  ? {
      ...(provider && { provider }),
      model,
      ...(reasoningEffort && { reasoningEffort }),
    }
  : undefined

// 4. 组装首条消息（与 coordinator worker 保持统一格式）
const instructions = String(spec.instructions ?? '').trim()
const text = instructions
  ? `Role (${args.preset}): ${instructions}\n\nTask:\n${args.prompt}`
  : String(args.prompt)

// 5. 生成可观测 label（展示预设、生效模型/思考档与任务简介）
const effectiveRoute = model
  ? { provider: provider || undefined, model, reasoningEffort: reasoningEffort || undefined, inherited: false }
  : {
      provider: parent.options?.provider,
      model: parent.options?.model,
      reasoningEffort: parent.options?.reasoningEffort,
      inherited: true,
    }
const badge = effectiveRoute.model
  ? ` [${[effectiveRoute.model, effectiveRoute.reasoningEffort].filter(Boolean).join(' · ')}]`
  : ''
const desc = String(args.description ?? '').trim()
const label = `${args.preset}${badge}${desc ? ' · ' + desc : ''}`

// 6. 调用 DSH 0.2.2-rc.x 新版扁平 startActivation
const started = await ctx.subagents.startActivation({
  provider: 'spawn',
  label,
  ...(args.name && { name: args.name }),
  parent,
  ...(args.cwd && { cwd: args.cwd }),
  prompt: [{ type: 'text', text }],
  ...(agentOptions && { agentOptions }),
  maxDepth: 1,
  signal: exec.signal,
  delivery: 'parent',
})

// 7. 返回明确回执，便于主 Agent 用 send_message / list_agents / interrupt_agent 接管后续交互
return {
  kind: 'activation',
  preset: args.preset,
  name: started.name,
  subagentId: started.childId,
  ...effectiveRoute,
}
```

#### 细节注意事项

- **动态预设列表可见性**：`ctx.tools.register` 的工具描述在注册时固定；如果用户在会话中途修改了 `config.agents`（如新加了自定义预设或改了绑定模型），可在 `ctx.systemPrompt.section`（`captainSection` 每次构建都会动态调用 `settings()`）里输出当前预设摘要行，这样热改配置也能立刻反映给主 Agent，而无需重启。
- **`name` 参数校验**：若调用方传入非法 `name`（不满足 `^[a-z][a-z0-9-]{0,31}$` 或等于 `lead`），要么前置清晰报错，要么直接交由宿主校验透传错误。
- **与 `dag_run` 的分工提示**：在 `captainSection`（`src/index.mjs`）补一句简短指引——单次或少量独立子任务可用新工具按预设派发；需要多票依赖编排、独立 git worktree 与自动集成验收时才走 `dag_run`。

### 4.3 同步升级现有 `launch()` 与包元数据（0.2.2 迁移）

由于本插件现有 worker 启动仍使用 0.2.1 的 `request` 包装（`src/index.mjs:289-296`），升级 DSH 后会直接报错，需同步改为扁平写法：

```js
// src/index.mjs:289-296（迁移后）
const activation = await ctx.subagents.startActivation({
  provider: 'spawn',
  label: childLabel + runId + '/' + ticketId + '#' + attempt,
  childId,
  parent,
  cwd,
  prompt: [{ type: 'text', text: prompt }],
  ...(agentOptions && { agentOptions }),
  signal,
  delivery: 'caller',
})
```

配套同步项：

- **`package.json`**：`engines.dsh` 与 `peerDependencies` 升级对齐到 `>=0.2.2-rc.2`（按实际升级后的 DSH 版本号微调）。
- **`docs/spec-delta-agents.md:26`**：更新 `request.agentOptions` 描述为扁平 `agentOptions`。
- **现有测试适配**（已全局检索，共 2 个文件）：
  - `test/host.test.mjs`（第 227、262、278–279 行：mock 从 `spec.request` 改为直接读 `spec` 顶层字段）。
  - `test/cancel-host.test.mjs`（第 86、94、102–105 行：mock 从 `spec.request.cwd` 改为 `spec.cwd`）。

### 4.4 改动文件清单与测试规划

| 文件 | 改动内容 |
|---|---|
| `src/index.mjs` | 1) `launch()` 迁移至 0.2.2 扁平 `startActivation`；2) 注册新预设子代理工具；3) `captainSection` 动态列出预设与使用指引 |
| `package.json` | 更新 `engines.dsh` 及 peer 依赖范围 |
| `docs/spec-delta-agents.md` | 同步 `startActivation` 扁平契约说明 |
| `test/host.test.mjs`、`test/cancel-host.test.mjs` | 将 mock `startActivation` 改为校验扁平 spec（并断言不存在 `spec.request`） |
| `test/preset-subagent.test.mjs`（新增） | 单元测试：预设命中与指令拼接、绑定模型传 `agentOptions`、未绑模型省略 `agentOptions` 并标 `inherited: true`、未知预设报错、无效模型/思考档由 `validateTicketRoutes` 拒绝不静默降级、扁平 `startActivation` 参数契约与 `delivery: 'parent'` + `maxDepth: 1`、关闭态拒绝 |

---

## 5. 开工前待确认的 3 个小决策

回家开始编码前，拍板下面 3 项即可直接实施：

- [ ] **工具命名**：`preset_subagent` vs `dag_subagent`（推荐 `preset_subagent`：语义独立于 DAG 流水线，不易让模型误以为会开 worktree，且带前缀不易与裸名 `delegate` 冲突）。
- [ ] **是否允许单次临时换模型**：
  - 选项 A（推荐首版）：**纯按预设走**，不提供调用期 `provider`/`model` 覆盖参数，保持职责单一。
  - 选项 B：额外提供可选 `provider` / `model` / `reasoning_effort` 覆盖参数（需成对传 `provider` + `model` 并走 `validateTicketRoutes` 校验）。
- [ ] **是否支持 `fork` 模式**：
  - 选项 A（推荐首版）：只做全新上下文 `provider: 'spawn'`。
  - 选项 B：增加可选 `fork: boolean` 参数，为 `true` 时切到 `provider: 'fork'` 继承当前对话历史。
