# herdr-personal

My [Herdr](https://herdr.dev) setup (`~/.config/herdr-app`) on my personal Mac.
Started from my work setup, now its own thing.

- `layouts/lucasprag.json`: Herdr's original look with ~70% smaller gaps (2px),
  spaces and agents on the left, side panel with Files, Changes, PRs and Automations.
- `keys.json`: my key bindings.
- `mods/`:
  - `lucasprag-tabs`: tab bar with automatic tab names, middle-click close, PRs/Automations buttons.
  - `lucasprag-status`: status bar with Claude/Codex usage left (Keychain token, ~/.codex auth).
  - `lucasprag-agents`: agents list with the space's avatar on rows outside a space header.
  - `lucasprag-spaces`: spaces list; + opens new-space; automation spaces keep their own row.
  - `lucasprag-menu`, `lucasprag-new-menu`, `lucasprag-changes`: copies of Herdr's mods (0.1.13) to change freely.
  - `new-space` (Cmd+N): start a space from a folder in ~/Projects.
  - `agent-picker` (Cmd+Shift+T): start an agent with a chosen model.
  - `prs`: GitHub PRs that need me, via `gh`.

Not in this repo: Automations, installed from
[herdr-automate-everything](https://github.com/lucasprag/herdr-automate-everything)
(checkout in ~/Projects/herdr-automate-everything, `scripts/install-mod.sh`).
