# pstack → DSH 迁移方案

> **实施状态（2026-10-22）**：本方案已落地为仓库 `~/workspace/dsh-pstack`，远端 `github.com/lqhl/dsh-pstack`。
> 与下文计划的差异只有两处：仓库放在 `~/workspace/dsh-pstack`（不是 `~/.dsh/dsh-pstack`），且
> `~/.dsh/pstack` 现在是指向 `vendor/pstack` 的软链。实际结构见仓库 README；下文保留为决策记录。

调研时间：2026-10-22　目标宿主：dsh 0.2.1-rc.2 / profile `web`　上游：`cursor/plugins@pstack` v0.15.30（MIT）

---

## 1. 结论

**可行，而且比官方已有的 Claude Code 适配更接近原生。**

三条判断：

1. **内容层几乎零成本。** pstack 是 57 个 `SKILL.md`（212 KB）+ 23 个 playbook（90 KB）+ 33 个 reference，纯 Markdown。DSH 的 skill 目录协议（`<name>/SKILL.md` + YAML frontmatter）与 Cursor 同源，字段名完全一致，未知字段（`icon`、`color`、`paths`）被静默忽略。拷进去就能被 `/` 菜单和 `/name` 调用。
2. **执行层已经就位。** 当前 `standard` preset 已经挂了 skill 目录、`subagent`（含 spawn/fork）、`workflow` JS 编排、`todo_write`、`schedule`、`goal`、plan mode、`AGENTS.md` 注入。pstack 需要的"父代理 + 多模型子代理 + 面板评审"在 DSH 里都有对应原语。
3. **真正的成本在 6 个 harness 缝**：模型路由默认关闭、`subagent_type` 无直接对应、`/loop` 语义不同、readonly 子代理无法强制、并发/深度上限、Cursor 专有面（Automations / Bugbot / cursor-team-kit）。这 6 个缝决定的是一个约 200 行的适配文档 + 一个可选 preset bundle，不是一个 fork。

**推荐路线**：不 fork 上游，按上游给 Claude Code 的做法加一层 `harness/dsh` 适配（一个 adapter 文档 + 57 个符号链接 + 3 项宿主设置），先跑通 M0–M2（约 3 人日），再决定要不要为保真度做 preset bundle。

---

## 2. pstack 是什么（实测构成）

| 组成 | 规模 | 作用 | 对 harness 的依赖 |
|---|---|---|---|
| `skills/` 57 个 | 212 KB | 入口（`poteto-mode`、`setup-pstack`）+ 43 条 principle + 12 个流程 skill | 目录扫描、`/name` 调用、子代理、模型选择 |
| `skills/poteto-mode/playbooks/` 23 个 | 90 KB | 任务分类后的逐步 playbook（feature / bug-fix / babysit / shipping / orchestrate / autopilot…） | 按相对路径读取 |
| `skills/*/references/` 33 个 | — | 评审 prompt、triage 表、来源 playbook | 按需读取 |
| `agents/` 2 个 | — | `poteto-agent`（通用 delegate）、`comment-sicko`（注释猎手） | 子代理类型 + 固定 persona |
| `automations/benny/` | 14 个文件 | Slack issue → triage / repro 的 Cursor Automations 包 | Cursor 云代理 + webhook |
| `docs/guide/` 10 篇 | — | 人类导览 | 无 |
| `skills/poteto-mode/scripts/` | 4.3 K 行 TS | `orch`（编排状态）、`watch-pr`（PR 轮询）、`check-plan`、`bootstrap`、`worktree-audit.sh` | Bun + `gh` |

**frontmatter 实测**：56/57 个 skill 带 `disable-model-invocation: true`，只有 `setup-pstack` 没有；没有任何一个带 `user-invocable: false`。

这条事实很关键：在 DSH 里这意味着 **模型目录只会多出 1 条（`setup-pstack`），而 `/` 菜单会完整出现 57 条**——这正是 pstack 在 Cursor 里的设计意图（"your skill catalog hides this skill"）。目录污染风险基本为零。

**Cursor 专有 API 的分布**（决定适配面）：43/177 个文件提到 `Task` / `subagent_type` / `AskQuestion` / Bugbot / cursor-team-kit / `.cursor/` / `/loop`。其中 `poteto-mode/SKILL.md`、`setup-pstack`、`arena`、`swarm`、`reflect`、`no-comments`、`autonomous-run`、`babysit`、`shipping`、`orchestrate` 是重灾区。

---

## 3. DSH 侧能力盘点（以实物为准）

来源：`dsh --profile web --dump-config`、`~/.dsh/profiles/web/cordis.patch.yml`、各包 README。

| 能力 | DSH 实现 | 当前状态 |
|---|---|---|
| skill 发现 | `dsh-skill-filesystem`：`.dsh/skills`(100) / `.agents/skills`(200) / custom(300) / `~/.dsh/skills`(400) / `~/.agents/skills`(500) | preset 内已挂 |
| skill 调用 | `dsh-tool-skill`：模型 `skill` 工具 + 用户 `/name` 直接注入 | 已挂 |
| 子代理 | `subagent`（spawn，异步 + 完成通知）、`subagent_fork`（继承上下文） | 已挂，`modelSelectionSettings: true` |
| 子代理模型 | 工具参数 `provider` / `model` / `reasoning_effort` | **要 Host 设置启用，默认 `enabled: false`** |
| 多代理编排 | `workflow`（JS 脚本，`agent(prompt,{provider,model})` 可逐个子代理换模型） | 已挂 |
| 待办 | `todo_write`（`allowParallelInProgress: true`） | 已挂 |
| 定时/循环 | `schedule_create/list/update/delete`（cron / every / daily） | 已挂 |
| 长任务不中断 | `create_goal` + goal round driver（默认 256 轮） | 已挂 |
| 计划模式 | plan mode + `exit_plan_mode` | 已挂 |
| 用户提问 | `ask_user_question` | 已挂 |
| 常驻指令 | `dsh-agent-instructions`：`~/.dsh/AGENTS.md` → `~/.agents/AGENTS.md` → 项目链 | preset 内已挂 |
| 人格/身份 | `dsh-persona`（preset 内 `prefix` / `complete`） | preset 内已挂 |
| 工作树隔离 | `dsh-experimental-tool-worktree`（默认关） | 需装 |
| 历史召回 | `dsh-experimental-session-search` / `dsh-tool-session-query`（默认关） | 需装 |
| 无头执行 | `dsh headless "<task>"`（一次性，`--json`，`--session-id`） | 可用 |
| MCP | `dsh-mcp-client` | 按需 |

**已配置的多模型路由**（`cordis.patch.yml`，Magpie 网关）：

- `magpie`：`auto/claude-opus-5-5`、`auto/claude-sonnet-5-5`、`auto/claude-haiku-5.5`、`deepseek/deepseek-flash`（含 low→max effort）
- `magpie-responses`：`codex/gpt-6-astra`、`codex/gpt-6-luna`、`codex/gpt-6.1-sol`、`grok/grok-4.7@500k`（grok 上限 xhigh）

这套路由足以还原 pstack 的 "opus 判判断 / grok 写码" 双面板，Claude Code 适配里做不到（那边 grok/gpt 只能退回 session 模型）。

**关键上限**：`subagent.maxDepth` 默认 **1**（子代理不能再委派）；`maxActiveSubagents` 默认 **8**。

---

## 4. 逐项映射

### 4.1 工具

| pstack / Cursor | DSH | 备注 |
|---|---|---|
| `Task`（`subagent_type`, `model`, `prompt`） | `subagent`（`prompt`, `provider`, `model`, `reasoning_effort`, `cwd`） | 天然异步，返回 childId；完成时通知父代理 |
| `Task` + `resume` | `send_message` 给已有 child，或 `subagent_fork` | pstack 自己更推崇"开新代理 + 合并简报"，与 spawn 一致 |
| `subagent_type: "poteto-agent"` | 简报里给 `poteto-mode/SKILL.md` 绝对路径；或 preset（见 M3） | pstack 的 `poteto-agent.md` 本来就只做"读入口文件" |
| `readonly: true` | 只读 preset / 简报约束 + 事后 `git status` | DSH 无内建只读子代理 |
| `environment: "cloud"` | `worktree` 工具（`dsh-experimental-tool-worktree`） | 语义接近，非等价 |
| `run_in_background: true` | 省略 | 子代理本来就后台 |
| `AskQuestion` | `ask_user_question` | 名字不同，参数形状近似 |
| 开 todolist | `todo_write` | playbook 步骤逐字进首项 |
| `/loop until X` | `create_goal` + `schedule_create(every_seconds)` | 组合语义，见 4.3 |
| `Read` / `Grep` / `Glob` | `read` / `grep` / `glob` | 同名同义 |
| Cursor Automations | 无 | 外部 cron + `dsh headless` |
| Bugbot | 无 | 退化为普通 review thread |
| `cursor-team-kit` 的 `deslop` / `control-ui` / `control-cli` | `unslop`（已在 pstack）+ 项目自建 `verify-*` skill | `control-*` 与 pstack 自己的 `create-verification-skill` 重叠，用后者替代 |

### 4.2 模型

pstack 的模型选择走两层：skill 文本里的默认 slug（`grok-4.7-xhigh-fast` / `claude-opus-5-5-xhigh`）+ `~/.cursor/rules/pstack-models.mdc` 的角色覆盖。DSH 里两层都能保留，只要把"slug"换成"provider/model + effort"三元组。

| pstack 角色 | 默认 | DSH 目标 |
|---|---|---|
| `feature, refactoring` / `bug-fix` / `perf-issue` / `hillclimb` | `grok-4.7-xhigh-fast` | `magpie-responses` + `grok/grok-4.7@500k` + `xhigh` |
| `judgment and prose` / `hardest tasks` | `claude-opus-5-5-xhigh` | `magpie` + `auto/claude-opus-5-5` + `xhigh` |
| `swarm workers` | `grok-4.7-xhigh-fast` | 同上（grok） |
| `arena runners` / `interrogate reviewers` / `architect runners` | 双模型列表 | 两个 ent 各一，`workflow` 里逐个子代理指定 |
| `inherit-parent` / `auto` | 继承父模型 | 省略 `provider` / `model` |

注意：`allowedModels` 只登记 `provider/model` 对，effort 是调用时参数，因此一张 allowlist 可覆盖全部角色。

### 4.3 命令与循环

| Cursor | DSH | 差异 |
|---|---|---|
| `/poteto-mode <task>` | `/poteto-mode <task>`（skill 可被用户调用，注入正文） | 一致 |
| Custom Mode（常驻） | `~/.dsh/AGENTS.md` 里的常驻段，或 `pstack` preset 的 persona | 一致；Cursor 的"模式切换"变成"preset 选择" |
| `/loop until <predicate>` | `create_goal(objective)` 给目标，`schedule_create(every_seconds=600, prompt="检查 <predicate>，未达成继续")` 给心跳；`goal-round-driver` 自动续轮 | 没有原生"事件唤醒"；CI/PR 事件用后台 `bash` 任务 + `job_output`，或 schedule 轮询 |
| `/setup-pstack` | 写 `~/.dsh/AGENTS.md` 的 pstack 段（不是 `.mdc`，无 frontmatter） | 见 5.2 |
| `/create-skill`（Cursor 内建） | 无内建；改用 pstack 自己的 `authoring-a-skill` playbook | 一行跳过 |

### 4.4 路径

| Cursor | DSH |
|---|---|
| `.cursor/skills/`、`~/.cursor/skills/` | `.dsh/skills/`、`~/.dsh/skills/`（或 `.agents/skills/`） |
| `~/.cursor/rules/pstack-models.mdc` | `~/.dsh/AGENTS.md` 的 pstack 段 |
| `~/.cursor/plugins/…/skills/poteto-mode/SKILL.md` | `~/.dsh/pstack/skills/poteto-mode/SKILL.md`（绝对路径写进子代理简报） |
| `.cursor/automations/benny/` | 无（外部 cron + `dsh headless`） |
| `~/.cursor/projects/<slug>/agent-transcripts/*.jsonl` | `session_query` 工具，或 `~/.dsh/sessions` | 
| `https://github.com/cursor/plugins/blob/main/pstack/<path>` | 本地 checkout（不要联网取） |

---

## 5. 差距与风险

### P0（不做就跑不起来）

**P0-1 子代理模型路由默认关闭。**
`subagent` 工具虽然配了 `modelSelectionSettings: true`，但 Host 的 `subagent-model-selection` 默认 `enabled: false`，且 `allowedModels` 为空（启用但空列表会直接抛错）。不启用时工具不暴露 `provider/model/reasoning_effort` 字段，pstack 里 8 处按角色选模型全部退化成"跟随父模型"。这是**第一优先级**。

**P0-2 playbook 的相对路径解析。**
`poteto-mode/SKILL.md` 写 `Bundled skills live at ../<name>/SKILL.md`、playbook 写 `playbooks/<title>.md`。DSH 的 `read` 按 cwd 解析相对路径，不按 skill 根。必须在适配层固定一条规则：**skill 内所有相对路径以该 skill 的 base directory 解析**（`skill` 工具返回值里已经带了 `Base directory for this skill:`），并优先用绝对路径。这是最容易出错、也最容易一次修好的点。

**P0-3 通用名冲突。**
`how` / `why` / `tdd` / `teach` / `bro` / `ketchup` / `recall` / `reflect` / `unslop` / `arena` / `swarm` 是通用词。装到 `~/.dsh/skills`（rank 400）会压过内置（600），且未来任何同名词包都会被静默覆盖。取舍见 §9 决策 3。

### P1（能力降级，需显式设计）

**P1-1 `subagent_type` 无对应。** 只有 preset 能表达"带固定 persona 和工具集的子代理"。不建 preset 时，退化为"在简报里写：先读 `<abs>/poteto-mode/SKILL.md`"——pstack 的 `agents/poteto-agent.md` 正文本来就是这个意思，所以可接受，但 `comment-sicko` 这种纯 persona 代理会多一次读文件。

**P1-2 readonly 无法强制。** `readonly: true` 在 Cursor 里剥掉写工具和 MCP。DSH 只能靠 preset 的工具集裁剪，或提示词约束 + 事后 `git status`。plan mode 是唯一强制的只读态，但它是会话级不是子代理级。

**P1-3 `maxDepth=1`。** 子代理不能再开子代理。pstack 的 `orchestrate`、`autopilot-full`、`autopilot-stack` 明确要求"协调者 → owner → worker"三层。要跑这些 playbook，必须把 Host `subagent.maxDepth` 提到 2 或 3（Settings → Subagent，或工具行配 `maxDepth`）。

**P1-4 `/loop` 没有事件原语。** pstack 的 autonomous-run 预期"watcher 子代理在事件发生时唤醒"。DSH 的 `schedule` 是时间驱动，`jobs` 是进程内后台。用 schedule 轮询 + goal 续轮可以覆盖 80% 场景（"每 10 分钟检查一次 CI"），覆盖不了"PR 一合并就立刻动"的低延迟。

**P1-5 并发上限 8。** `maxActiveSubagents` 默认 8，pstack 的 `swarm`/`arena` 动辄 N=6–12。超限时创建直接 `ACTIVATION_LIMIT_REACHED`，不排队。要跑面板就调高。

### P2（可接受缺失）

| 项 | 处理 |
|---|---|
| Cursor Automations（benny） | 适配层一行跳过；真要跑，写外部 cron + `dsh headless`（独立小项目） |
| Bugbot | 当普通 review thread 分诊；跳过"配置/等待 Bugbot"的步骤 |
| Cursor cloud agents | 映射到 worktree；跳过"云代理面板/远程机器"的步骤 |
| `cursor-team-kit` | 删引用；`deslop`→`unslop`，`control-*`→项目 `verify-*` skill |
| Bun | 本机 Node v26 原生跑 TS；`bootstrap.ts` 的 `Bun.spawnSync` 改 3 行 `child_process`；`bun:test` → `node:test`；`watch-pr` shebang 改 `node` |
| `statechart` | 保持原样，依赖外部 `tla2tools.jar` + Java（环境要求写进 adapter） |
| 8 KB tool-result pruner | 仅在上下文有压力时截断 head 4 KB + tail 1 KB；pstack 的"入口薄 + 分片引用"结构本来就规避了这个问题，无需改 |

---

## 6. 推荐架构

三层，**上游零改写**，这是能长期 `git pull` 的前提。

```
~/.dsh/
├── AGENTS.md                 # 用户全局指令（rank: 最先注入）
│   ├── ... 原有内容
│   └── <!-- pstack -->      # 由 /setup-pstack 写入的角色模型表 + adapter 指针
├── pstack/                   # git checkout（跟上游 main）
│   ├── skills/  agents/  docs/  automations/
│   └── harness/dsh/
│       ├── adapter.md        # ★ 核心产物：Cursor→DSH 词汇表（约 200 行）
│       └── install.sh        # 建符号链接 + 校验，幂等
└── skills/                   # 扫描根 rank 400
    ├── poteto-mode -> ../pstack/skills/poteto-mode
    ├── how        -> ../pstack/skills/how
    └── …（57 个符号链接）
```

为什么用符号链接而不是 `customSkillDirs`：`customSkillDirs` 需要覆写 `preset-standard` 的整份 plugin 列表（patch 的 `config` 是整体替换，不深合并），代价过高。符号链接被 `dsh-skill-filesystem` 明确支持（"including symlinks"），`git pull` 即生效，且 rank 400 优先级稳定。

**为什么不 fork**：上游已经为 Claude Code 维护了一套生成树（`harness/pstack/` + `scripts/generate-pstack-harness-trees.mjs`）。DSH 应该走同一条路：先做**纯适配层**（不改任何 `SKILL.md`），只有确实需要字面路径的地方才在 `install.sh` 里做 sed 生成。这样上游每周更新不会产生冲突。

---

## 7. 适配层核心内容（adapter.md 骨架）

照 `docs/harness/claude-code.md` 的形状写，但 DSH 的表格更短、更强。

```
# pstack in DSH
每个会话读一次本文件，然后按下表翻译 skill 里的 Cursor 名字。
<pstack> = /home/qliu/.dsh/pstack。skill 内的相对路径一律相对该 skill 的 base directory。

## 工具
Task                → subagent（prompt 必填；provider/model/reasoning_effort 可选）
Task + resume       → send_message，或 subagent_fork
AskQuestion         → ask_user_question
开 todolist          → todo_write（playbook 步骤逐字进首项）
跑另一个 pstack skill → read "<pstack>/skills/<name>/SKILL.md"，或让用户输入 /<name>
Grep / Glob         → grep / glob
Read                → read
run_in_background   → 省略（子代理天然后台）

## 子代理字段
subagent_type: poteto-agent → 简报第一行写：先完整读 <pstack>/skills/poteto-mode/SKILL.md
subagent_type: comment-sicko→ 简报里粘贴 <pstack>/agents/comment-sicko.md 全文
readonly: true              → 简报写"只读，不要写文件"，并在验收前跑 git status
environment: "cloud"        → worktree 工具（不可用时跳过并说明）
resume                      → 新开子代理，把上一轮结论粘进简报

## 模型
pstack 的 slug → provider / model / effort：
  grok-4.7-xhigh-fast   → magpie-responses / grok/grok-4.7@500k  / xhigh
  claude-opus-5-5-xhigh → magpie           / auto/claude-opus-5-5 / xhigh
  *-max                 → 同 family，effort=max
  *-medium / *-high     → 同 family，effort 降级
  inherit-parent / auto → 省略 provider 和 model
角色→模型的行写在 ~/.dsh/AGENTS.md 的 pstack 段；缺行就用 skill 默认。

## setup-pstack
把 ~/.cursor/rules/pstack-models.mdc 换成 ~/.dsh/AGENTS.md 里的一段：
无 .mdc frontmatter，其余（# budget 行 + 每角色一行）逐字保留，整段覆盖写入。

## 路径
.cursor/skills/        → .dsh/skills/（项目）或 ~/.dsh/skills/（个人）
~/.cursor/rules/*.mdc  → ~/.dsh/AGENTS.md
~/.cursor/plugins/     → <pstack>
agent-transcripts/     → session_query 工具，或 ~/.dsh/sessions

## DSH 专有
- 需要"常驻 poteto-mode"时，不要依赖 Custom Mode；把 poteto-mode 的 Non-negotiables
  放进 AGENTS.md，或在 pstack preset 的 persona 里引用。
- 需要"跑 N 个候选/评审"时，优先用 workflow，逐个子代理指定 provider/model，
  比 N 次 subagent 调用更省父上下文。
- 需要"跑到达成为止"时，create_goal + schedule_create，不要写 while 循环。

## Cursor 专有（跳过，一行说明）
Cursor Automations、Bugbot、Cursor cloud agents、cursor-team-kit（deslop / control-ui / control-cli）、
/create-skill。写 `Skipped in DSH: <step>. <reason>.` 然后继续，不要停、不要问、不要重试。
```

`AGENTS.md` 里的 pstack 段（约 25 行）：

```markdown
<!-- pstack:model-roles -->
# budget: large (xhigh)
feature, refactoring: magpie-responses/grok/grok-4.7@500k xhigh
bug-fix: magpie-responses/grok/grok-4.7@500k xhigh
perf-issue: magpie-responses/grok/grok-4.7@500k xhigh
hillclimb: magpie-responses/grok/grok-4.7@500k xhigh
judgment and prose: magpie/auto/claude-opus-5-5 xhigh
hardest tasks: magpie/auto/claude-opus-5-5 max
swarm workers: magpie-responses/grok/grok-4.7@500k xhigh
arena runners: magpie/auto/claude-opus-5-5 xhigh, magpie-responses/grok/grok-4.7@500k xhigh
interrogate reviewers: magpie/auto/claude-opus-5-5 xhigh, magpie-responses/grok/grok-4.7@500k xhigh
```

---

## 8. 实施阶段

### M0　冒烟（0.5 人日）

1. `git clone --depth 1 --filter=blob:none --sparse https://github.com/cursor/plugins ~/.dsh/pstack`，再 `git -C ~/.dsh/pstack sparse-checkout set pstack`；把内容按 `~/.dsh/pstack/skills` 布局摆好（rename 一次即可）。
2. `install.sh` 建 57 个符号链接到 `~/.dsh/skills/`：

```bash
#!/usr/bin/env bash
set -euo pipefail
root="$HOME/.dsh/pstack/skills"; dest="$HOME/.dsh/skills"
mkdir -p "$dest"
for d in "$root"/*/; do
  name="$(basename "$d")"; [ -f "$d/SKILL.md" ] || continue
  ln -sfn "../pstack/skills/$name" "$dest/$name"      # 相对链接，整目录搬走也不断
done
# 只装一个子集时改成白名单：for name in poteto-mode poteto-help setup-pstack how why unslop …; do
```

3. 新开会话，验证四件事。

**验收**：
- `/` 菜单出现 57 项；模型目录只多出 `setup-pstack` 一条
- `/poteto-mode 给 X 加一个 --json flag` → 回复开头打开 todo，**首项是 Feature playbook 的步骤原文**
- 模型能 `read` 到 `~/.dsh/pstack/skills/poteto-mode/playbooks/feature.md`
- 子代理调用成功（此时还不带模型参数）

### M1　适配层（1.5 人日）

1. 写 `harness/dsh/adapter.md`（§7 骨架 + 43 个文件的逐条对照）
2. `AGENTS.md` 加"pstack 常驻段"：adapter 指针 + 模型角色表 + 相对路径规则
3. 处理 6 处必须字面改写的引用：`setup-pstack` 的输出路径、`create-verification-skill` 的输出目录、`reflect`/`automate-me` 的 transcript 路径、`poteto-mode` 的 base dir 说明、`poteto-agent.md` 的搜索路径

**验收**：拿 3 个 playbook（feature / bug-fix / interrogate）各跑一次，产物与 Cursor 版本对比无结构性差异；`git status` 确认上游文件零改动。

### M2　宿主设置（1 人日）

1. Plugins → Subagent → *Model selection*：打开 `subagent-model-selection`，`allowedModels` 填 `magpie / auto/claude-opus-5-5`、`magpie-responses / grok/grok-4.7@500k`（可再加 `codex/gpt-6.1-sol`）
2. 同页 limits：`subagent.maxDepth` → 2
3. `maxActiveSubagents` → 12：同页若没暴露，就在 `~/.dsh/profiles/web/cordis.patch.yml` 覆盖 `- id: subagent` 的 `config.maxActiveSubagents`（这是 Host 插件配置，不是设置项）

**验收**：一次 Feature 任务里，子代理调用带 `provider/model/reasoning_effort`；`list_subagent_models` 出现；代码 delegate 落在 grok、judgment 落在 opus。

### M3　保真度（2–3 人日，可选）

1. 一个 `pstack` preset bundle（`plugin_manager install_bundle`）：复制 `standard` 的 plugin 列表 + 三处改动
   - `persona`：注入 poteto-mode 的 Non-negotiables（常驻）
   - `tool-subagent`：`agentPreset: poteto-agent`、`allowedAgentPresets: [poteto-agent, comment-sicko, readonly-worker]`
   - 新增 `subagent_readonly` 实例：固定只读 preset，工具集只留 `read/grep/glob`
2. 三个子 preset：`poteto-agent`（全工具）、`comment-sicko`（persona 全文）、`readonly-worker`（无写工具）
3. `swarm` / `arena` / `interrogate` / `reflect` 的"N 个不同模型"改写成 `workflow` 脚本（`agent(prompt,{provider,model})` 本来就支持逐个覆盖）
4. autonomous-run：`create_goal` + `schedule_create` 替换 `/loop`

**代价**：`preset-standard` 的 `config` 会被整体替换，dsh 升级新增的 preset 行需要手工同步。这是唯一需要"跟版本"的地方。

### M4　自动化与回归（按需）

- benny：`dsh headless` + systemd timer / GitHub Action，状态落 issue 评论
- eval：挑 5 个历史任务做基线，比较 Cursor 版与 DSH 版的通过率、回合数、token

**总工作量**：M0–M2 约 3 人日可日常使用；M0–M3 约 5–6 人日；M4 视自动化范围另计。

---

## 9. 决策（1–3 已定，4–5 待定）

| # | 决策 | 选项 | 结论 |
|---|---|---|---|
| 1 | 保真度 | A：只做 M0–M2／B：加 M3 preset | **已定 B**：M3 必做，`subagent_type` / readonly 子代理按 preset 实现 |
| 2 | 模型 | 双模型（opus+grok）／单模型 | **已定**：父代理与代码 delegate 统一 `magpie / deepseek/deepseek-flash` + `max`；重要场景用 `magpie-responses / codex/gpt-6.1-sol` + `medium`。`allowedModels` 只需登记这两条路由 |
| 3 | 安装位置 | 全局／项目级 | **已定全装**：57 个进 `~/.dsh/skills` |
| 4 | 上游策略 | 本地私有适配 ／ 给上游提 `harness/dsh` PR | 见 §11：先本地 overlay repo，不 fork |
| 5 | Automations | 跳过 ／ 外部 cron + headless | 建议跳过。benny 依赖 Slack + 云端仓库权限，ROI 最低 |

> 决策 2 的副作用要说清：单模型下 `arena` / `interrogate` / `reflect` / `swarm` 的"多模型交叉"退化成"同模型多次独立上下文"。评审仍有价值（独立上下文会撞出不同结论），但比跨 family 弱。缓解方式：这几个 skill 的 `runners` 行显式写成两条 —— 一条 deepseek-flash max，一条 gpt-6.1-sol medium，只在这类面板里付跨模型的钱。

---

## 10. 附：本次调研的证据

| 结论 | 证据 |
|---|---|
| skill 格式同源 | `dsh-skill-filesystem` 解析 `name`/`description`/`disable-model-invocation`/`user-invocable`；未知键忽略（`lib/index.js` `parseInvocationPolicy`） |
| 56/57 不污染模型目录 | `grep -L 'disable-model-invocation: true' skills/*/SKILL.md` → 仅 `setup-pstack` |
| 目录扫描深度 | 只扫顶层 `<name>/SKILL.md`，不扫 `**/SKILL.md`；pstack 布局正好一层 |
| 模型路由默认关 | `dsh-tool-subagent/lib/model-selection-settings.js`：`enabled: z.boolean().default(false)`，启用时 `allowedModels` 必须非空 |
| 标准 preset 已开路由开关 | `dump-config` `preset-standard` → `tool-subagent.config.modelSelectionSettings: true` |
| 深度/并发上限 | `dsh-subagent` README：`maxDepth` 默认 1、`maxActiveSubagents` 默认 8 |
| 8 KB pruner 非永久截断 | `dsh-compaction-tool-result-pruner`：仅在压缩触发后裁剪，完整结果留在 session log |
| 符号链接可用 | `dsh-skill-filesystem` README："Reload locators and resource bases retain the discovered paths, including symlinks" |
| Bun 可去 | Node v26 原生 TS；Bun 只出现在 `bootstrap.ts` 的 `Bun.spawnSync` 和 5 个测试文件的 `bun:test` |
| 上游已有 harness 先例 | `docs/harness/claude-code.md` + 根目录 `scripts/generate-pstack-harness-trees.mjs` |

上游许可 MIT，vendoring 时保留 `LICENSE` 与作者署名。

---

## 11. 维护与上游跟进

### 11.1 结论

- **不 fork。**
- 维护**一个自己的小 repo**（overlay repo），上游以「只读快照 + commit sha」进 `vendor/pstack`。
- 漂移不靠人眼 diff，靠 3 个机器检查里最关键的 1 个：**上游 CI 已经把"哪些 Cursor 词汇存在"枚举成了机器可读的契约**。

### 11.2 上游事实（决定策略的那几条）

| 事实 | 数值 |
|---|---|
| 仓库形态 | 11 MB monorepo，根目录 24 个插件，pstack 只是其一 |
| pstack 改动频率 | 每天 1–3 个提交；三天内 4 个版本（0.15.26 → 0.15.30） |
| 发布方式 | 没有 tag，版本号只在 `plugin.json` |
| CI 触发 | PR 触碰 `pstack/**`、`harness/**`、`scripts/**` 就跑 `generate-pstack-harness-trees.mjs --check` |
| 活跃度 | 13.5k stars，最近提交 2026-10-22 |

推论：fork 等于**每天都有东西想合并到你身上**，而我们的改动 100% 在 overlay 里，根本没有可冲突的文件。fork 的唯一收益（能提 PR）用一个临时分支就能拿到。

### 11.3 上游已经内置了漂移契约（关键发现）

`scripts/generate-pstack-harness-trees.mjs` 里有三样东西，恰好就是我们需要的维护工具：

1. **`TERMS` 词表**（22 条）：`` `Task` ``、`AskQuestion`、`todolist`、`generalPurpose`、`poteto-agent`、`comment-sicko`、`readonly: true`、`environment: "cloud"`、`run_in_background`、`resume`、`claude-`、`grok-`、`gpt-`、`inherit-parent`、`pstack-models.mdc`、`.cursor/skills/`、`.cursor/plugins/`、`.cursor/rules/`、`agent-transcripts`、Bugbot/Automations/cloud agents……
2. **覆盖率断言**：`FAIL Claude Code adapter has no row for <key>, used by <skill>` —— adapter 必须对每个出现过的词有一行，否则构建失败。
3. **`--check` 门禁**：生成树与源不一致就 red。

也就是说：**"pstack 用了哪些 Cursor 专有名词"这件事，上游替我们维护成了一张会自我校验的表。** 我们的 `adapter/dsh.md` 用同一套 key，覆盖率就能在本地验证。他们哪天加了一个新词或新 skill，我们下次 `make sync` 的第一项检查就会直接报「缺哪几行」，而不是"读 43 个文件找差异"。

### 11.4 仓库形态

```
dsh-pstack/                       # 我们自己的 git repo（本地 git 即可，建议加私有远端做备份）
├── vendor/pstack/                # 上游快照，只读，永不手改
│   ├── skills/  agents/  docs/  automations/
│   └── UPSTREAM                  # cursor/plugins@eb4db2b5 · pstack 0.15.30 · 2026-10-22
├── adapter/
│   ├── dsh.md                    # ★ 唯一需要手写维护的文件（约 200 行）
│   └── check.mjs                 # 覆盖率 / slug / 链接检查
├── preset/                       # DSH bundle（决策 1 = B）
│   ├── package.json
│   └── cordis.patch.yml          # pstack + poteto-agent + comment-sicko + readonly-worker
├── agents-fragment.md            # 注入 ~/.dsh/AGENTS.md 的 pstack 段（模型角色表 + adapter 指针）
├── install.sh                    # 软链 57 个 skill + 注入 AGENTS 段 + 装 bundle（幂等）
└── Makefile                      # sync / check / install / rollback
```

**DSH 不需要生成树。** Claude Code 必须生成 `harness/pstack/claude-code/`，因为它只安装那个目录，所以要往 43 个 `SKILL.md` 的 H1 后注入一句"先读 adapter"。DSH 直接读 `vendor/pstack/skills/`（软链接），adapter 指针放进 `~/.dsh/AGENTS.md` 一次，之后每个会话、每个子代理都会注入。少一个生成步骤，也少一类不同步。

### 11.5 三道检查（`make check`）

| # | 检查 | 做法 | 红了说明什么 |
|---|---|---|---|
| A | 适配覆盖 | 从快照对应版本的上游脚本里抽出 `TERMS`，逐个断言 `adapter/dsh.md` 含该 key（和上游断言同构） | 上游新增了 Cursor 词汇 → 补 adapter 一行 |
| B | 模型 slug | 正则抽 `(claude\|grok\|gpt\|composer\|deepseek)-[\w.]+`，按 **family** 断言有映射；出现未知 family 直接失败 | 上游换了模型家族 → 补映射，或显式标 `inherit-parent` |
| C | DSH 基线 | `dsh --dump-config` 抽 `preset-standard`，与 `vendor/preset-standard.reference.yml` diff；断言 `tool-subagent.modelSelectionSettings: true` 与 `skill-filesystem` 仍在 | dsh 升级改了 preset 结构 → 同步我们那份 preset 副本 |

A 是主力，B/C 各约 30 行。上游的悬空链接检查可以省——我们 vendor 整个 `pstack/`，内部相对链接天然可达。

**C 的必要性来自决策 1。** 选 B 意味着我们的 preset 里复制了一份 `preset-standard` 的 plugin 列表（DSH 的 patch 是 `config` 整体替换，不深合并）。这是整个方案里唯一会随 dsh 版本漂移的资产，所以它必须有基线文件 + diff 检查，否则某次 dsh 升级新增的 preset 行会被我们静默丢掉。

### 11.6 同步节奏

```bash
make sync      # 拉上游 main → sparse checkout pstack → rsync 进 vendor/ → 写 UPSTREAM
make check     # A/B/C 三道
make install   # 软链 + AGENTS + bundle
```

- 节奏：**前一个月每周一次**（内容还在快速演进：statechart、formal verification 都是最近三天加的），稳定后每月，或"要用哪个 skill 再看它有没有更新"。
- `make sync` 成功后打 tag `sync-20261029-eb4db2b`，message 里带上游 sha，diff 就是"这次上游改了什么"的完整答案。
- 如果推到 GitHub，加一个夜间 Action：比对上游 HEAD 与 `vendor/pstack/UPSTREAM` → 有变化就自动开 PR（跑完 `sync` + `check`）；`check` 红了就开 issue，正文直接列出缺哪几个 adapter key。这一步做完，"跟进上游"就退化成"每周 merge 一个机器人开的 PR"。

### 11.7 回滚

快照是提交过的，回滚 = `git checkout sync-<旧> && make install`。正在跑的任务不受影响（它们读的是软链指向的目录，切回去即可）。

### 11.8 什么情况下才该 fork

只有一种：**必须改上游 `SKILL.md` 的正文**（比如某处 `.cursor/` 路径只能字面改，adapter 的"遇到 .cursor 就换 .dsh"规则覆盖不了）。

现在这个条件不成立——43 个文件里的 Cursor 词汇全部可以用"读 adapter 再翻译"解决，Claude Code 就是这么活的（它的生成树也只注入一句 adapter 指引，不改正文）。

真到了那天也不要 fork monorepo：`git filter-repo --subdirectory-filter pstack` 建一个**单插件镜像仓库**，再在镜像上 patch。fork 一个 11 MB、24 插件、每天更新十几次的仓库是纯负担。

**可提的上游 PR（不是 fork）**：`generate-pstack-harness-trees.mjs` 里 `TREE = "claude-code"` / `ADAPTER = "docs/harness/claude-code.md"` 是硬编码常量，参数化成 `--harness dsh` 大约 20 行。若被接受，上游就替我们维护 DSH 生成树和覆盖率门禁，我们只剩 adapter 文档。建议先本地跑顺、有真实使用证据再提。

### 11.9 「不跟随」也是合法状态

pstack 是自包含的 Markdown，钉在 0.15.30 不会腐坏，缺的只是新 skill 和新修法。跟随是优化，不是运行前提。这与 fork 正好相反：**分叉会随时间变贵，快照不会。**
