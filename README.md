# dsh-pstack

[dsh](https://github.com/deepseek-ai/dsh) 上的 [pstack](https://github.com/cursor/plugins/tree/main/pstack) 端口。
pstack 是 poteto（Lauren Tan）的一组 agent 工作流 skill：先想清楚再写，写更少但更对的代码，用多模型子代理做评审。

这个仓库不是 pstack 的 fork。它是一层**发行包装（overlay）**：上游快照原样放在 `vendor/pstack`，我们的东西只有
一份适配表、一份 preset 描述、一个安装脚本。上游怎么改都不会和这里产生合并冲突。

```
.
├── vendor/pstack/         上游快照，只读，永不手改（看 vendor/UPSTREAM 里的 sha）
├── vendor/baseline/       线上 standard preset 的基线，用来发现 dsh 升级带来的漂移
├── adapter/dsh.md.in      适配表：把 pstack 里的 Cursor 名词翻成 DSH（安装时渲染）
├── adapter/check.mjs      漂移检查：词汇覆盖 + 模型家族 + skill 完整性
├── preset/build.mjs       由基线 + pstack 差异生成 preset/cordis.patch.yml
├── preset/check.mjs       检查 C 项：线上 standard preset 是否变了
├── preset/cordis.patch.yml 生成物：4 个 agent preset
├── agents-fragment.md.in  注入 ~/.dsh/AGENTS.md 的段落（模型角色表）
├── install.sh             建软链、渲染 adapter、注入 AGENTS.md
└── Makefile               make / check / install / sync / baseline / preset
```

## 安装

```bash
make            # = make check && make install
```

`make install` 做四件事，全部幂等：

1. `~/.dsh/pstack` → 本仓库的 `vendor/pstack`（一个稳定路径，供适配表引用）
2. `~/.dsh/skills/<name>` → `../pstack/skills/<name>`，57 个；上游删掉的 skill 会自动清掉软链
3. 渲染 `~/.dsh/adapter/dsh.md`
4. 把 `agents-fragment.md.in` 注入 `~/.dsh/AGENTS.md` 的 `<!-- pstack:begin -->` 块，块外内容不动

preset 需要单独装一次（每个 profile 各一次）：

```
plugin_manager action=install_bundle target=<本仓库>/preset
```

## 用法

- **按需**：`/poteto-mode 给 X 加一个 --json flag，verify 两边`。skills 全在 `/` 菜单里。
- **常驻**：新会话选择 agent preset `pstack`。它在 persona 里要求先读 `poteto-mode/SKILL.md` 和适配表，
  等价于 Cursor 的 custom mode。
- **子代理类型**：`poteto-agent`、`comment-sicko`、`readonly-worker` 三个 preset 通过
  `subagent.agent_preset` 选择；父代理的 `allowedAgentPresets` 已经放开。
- **只读调查**：`subagent_readonly` 工具，固定挂 `readonly-worker`。

模型别名（改角色只改 `~/.dsh/AGENTS.md` 里那一段）：

| 别名 | 路由 | 用途 |
|---|---|---|
| `deepseek` | `magpie` / `deepseek/deepseek-flash` / `max` | 默认：写码、swarm worker、调查 |
| `gpt` | `magpie-responses` / `codex/gpt-6.1-sol` / `medium` | 判断、文案、评审面板 |
| `inherit-parent` / `auto` | 不传 provider/model | 跟随父代理路由 |

注意：`subagent` 只有在 Host 打开 *Model selection* 后才接受 `provider` / `model` / `reasoning_effort`。
没打开时适配表会让模型说一句然后退回父模型，不会静默假装路由成功。

## 维护

```bash
make sync        # 拉上游 main，更新 vendor/pstack + vendor/UPSTREAM，然后跑 check
make check       # A 词汇覆盖 / B 模型家族 / C skill 完整性
make check-preset# dsh 升级后：基线是否漂移
make baseline    # 采纳新的 standard preset 基线
make preset      # 重新生成 cordis.patch.yml
```

`make sync` 之后如果 `check` 报 `adapter has no row for <key>`，说明上游新增了 Cursor 名词：
在 `adapter/dsh.md.in` 补一行，再 `make install`。上游自己的 CI 会对 Claude Code 适配器做同样的断言，
所以这张词表永远是被维护的。

## 已知差异

- `readonly-worker` 无法在工具层面禁止写入：DSH 的 `tool-fs` 把 read/write/edit 打进一个包。
  它靠 persona 约束 + 适配表要求 `git status` 复核。真正的强制只读只有 plan mode。
- 子代理默认深度 2：`poteto-agent` 自己没有委派工具，所以"子代理再开子代理"不会发生。
- 没有 Cursor Automations / Bugbot / cloud agents；`automations/benny` 原样留在 vendor 里但不启用。
- 单模型为主：`arena` / `interrogate` / `reflect` / `swarm` 的多模型交叉需要显式在 `workflow` 里
  给每个 `agent()` 指定 `gpt`，否则是同一模型的多个独立上下文。

## 许可

本仓库自己的代码与文档：MIT。
`vendor/pstack` 是 [cursor/plugins](https://github.com/cursor/plugins) 的 MIT 内容，版权归 Lauren Tan，
原样保留，未做修改。
