# dsh-pstack

pstack for DeepSeek Harness. This package ships the pstack skills, playbooks, and four agent presets.

## Install

Open Plugins in the DSH Web UI, search for `@lqhl/dsh-pstack`, and install it. Or run:

    plugin_manager action=install_bundle target=@lqhl/dsh-pstack

Start a new session and select the `pstack` preset. The preset exposes the pstack skills to the `/` menu and enables poteto mode for the whole session.

## Use

- Type `/poteto-mode <task>` to run the pstack entry workflow.
- Delegate to `poteto-agent`, `comment-sicko`, or `readonly-worker` with the `subagent` tool.
- The `pstack` preset keeps the bootstrap prompt active without the slash command.

The package ships two helper skills, which the presets read by path:

- `pstack-dsh-adapter` translates the Cursor names in pstack skills into DSH tools.
- `pstack-models` lists the default provider, model, and effort for each pstack role.

## Model routing

The defaults are in the `pstack-models` skill. To change a role, run `/setup-pstack` or edit the pstack block in `$DSH_HOME/AGENTS.md`. User lines override the package defaults.

## Compatibility and limits

- The package needs DSH 0.2.2-rc.1 or a later 0.2.x release. On 0.2.2-rc.1, `@deepseek-ai/dsh-tool-subagent-control` registers `list_agents`. On 0.2.1, that tool is the separate `@deepseek-ai/dsh-tool-subagent-control/list-agents` plugin, which 0.2.2-rc.1 does not export.
- Skills load only in sessions that select the `pstack` preset. The shipped `standard` preset does not get `/poteto-mode`.
- The presets copy the shipped `standard` plugin list. A DSH change to that list needs a new package release.
- Cursor-only features are skipped. The adapter skill lists the exact mappings.

## License

MIT. The vendored pstack content is MIT, Copyright (c) Lauren Tan. See `THIRD_PARTY_NOTICES.md` and `licenses/pstack-LICENSE`.
