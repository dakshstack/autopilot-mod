# ✈ Autopilot for Claude Code

A Claude Code mod that picks the right model for each prompt, sends cheap jobs to cheaper subagents, and puts a mission-control pane beside your chat.

## What it does

- **Auto model routing.** Each prompt is rated quick, standard or deep, and the mod switches to haiku, sonnet or opus to match. Start a prompt with `++` to force max effort, or `--` to force quick.
- **CTO mode.** Opus plans the work and hands the edits and searches to sonnet or haiku subagents.
- **TL;DR replies.** Answers start with a one-line result, followed by a few short bullets.
- **Mission-control pane:**
  - Live view of the current tool and timer.
  - One-key buttons: commit, test, review, push, fix error.
  - Git status and the files touched this session.
  - Rate-limit and context meters, with per-agent token and dollar spend.
- **Live wire.** Animated rows for messages moving between your session, its agents and other sessions.
- **Above-prompt band.** One line showing the mode, running agents, usage, branch and level.
- **XP and streaks**, just for fun.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install autopilot --marketplace dakshstack/autopilot-mod
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install autopilot --marketplace dakshstack/autopilot-mod
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, then **Add marketplace** and enter `dakshstack/autopilot-mod`. Then click **Add plugin**.

## Use

- `/ap`: open the pane
- `/ap auto | opus | sonnet | haiku | off`: set the mode
- `/ap cto`: toggle CTO mode
- `/ap tldr`: toggle TL;DR replies

## License

MIT
