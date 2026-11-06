# AGENTS.md — run this repo on a fresh machine / 在新机器上跑起来

This file is for an AI coding agent (Claude Code, Codex, Cursor, …) that has to get this project running on someone else's computer. Follow the steps in order, run the commands yourself, and only stop to ask the human for the things marked **ASK**.

本文件写给 AI 编程 Agent：按顺序执行命令；只有标了 **ASK（询问）** 的地方需要向用户要信息。

---

## 0. What you are setting up / 你在部署什么

- **What it is:** a Node (TypeScript, run natively by Node ≥ 22.19) + Python (managed by `uv`) project.
- **Entry point:** `node src/cli.ts`, exposed as npm scripts.
- **External services:**
  - **OpenRouter:** required. It covers the LLM agent (`anthropic/claude-sonnet-5.5`), keyframes (`openai/gpt-image-2.6-sunburst`) and video review (`meta/muse-spark-1.3-contributor`).
  - **Statsig:** optional. It runs the A/B experiments; without it, use `--local`.
- **Cost:** a full run spends about $1–3 of OpenRouter credit, with a hard cap of `budget_usd` = $25.

## 1. Prerequisites / 前置依赖

Check each one; install whatever is missing (ask before using `sudo`).

```bash
node --version      # need >= 22.19.0   (macOS: brew install node ; or nvm install 22)
ffmpeg -version     # macOS: brew install ffmpeg ; Ubuntu/Debian: sudo apt-get install -y ffmpeg
uv --version        # curl -LsSf https://astral.sh/uv/install.sh | sh   (or brew install uv)
git --version
```

`uv` downloads its own Python 3.12, so the system Python version does not matter.

## 2. Install / 安装

```bash
cd <repo>
npm install
```

npm may warn that `allow-scripts` is not covering some packages. That is harmless; no install script is required.

## 3. Keys / 密钥 — **ASK**

Ask the human for these values (they are written to `.env`, which is gitignored; never commit them or echo them back):

| variable | required | where the human gets it |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | https://openrouter.ai/keys (starts with `sk-or-`) |
| `STATSIG_SERVER_SECRET` | for Statsig | Statsig console → Settings → Keys & Environments → Server Secret Keys (starts with `secret-`) |
| `STATSIG_CONSOLE_KEY` | for Statsig | same page → Generate New Key → type **Console**, *not* read-only (starts with `console-`). It creates and starts experiments |
| `STATSIG_PROJECT_ID` | optional | the id in the console URL `console.statsig.com/<id>/…`; only used for links in the report |

询问用户：OpenRouter key（必需）；Statsig 的 Server Secret 和 Console key（可选，没有就用 `--local` 离线跑）。

Then either run the interactive setup and paste the values when prompted:

```bash
npm run setup
```

or write `.env` yourself (copy `.env.example`) and run setup non-interactively:

```bash
cp .env.example .env    # fill in the values
npm run setup -- --yes
```

`setup` does five things and is safe to rerun:

1. It checks the tools.
2. It stores the keys.
3. It runs `uv sync` in `py/` and downloads the Noto Serif CJK font (about 20 MB, from GitHub).
4. It fits the audience model if `models/audience_model.json` is missing, in about 10 s.
5. It runs `doctor`.

If the Statsig keys are absent, setup writes `config/local.json` with `experiment.platform = "local"`.

## 4. Verify / 验证

```bash
npm run doctor        # every line must be ✓
npm run typecheck     # optional: tsc --noEmit
```

Typical failures:

| doctor says | fix |
|---|---|
| `OpenRouter key` ✗ | wrong or empty key, or no credit → ask the human |
| `model … not listed on OpenRouter` | the model id was renamed. Pick the closest one from `https://openrouter.ai/api/v1/models` (or `?output_modalities=image` for images) and set it in `config/local.json`, e.g. `{"models":{"image":"openai/gpt-image-2"}}` |
| `Statsig console API key` ✗ (401) | the key is read-only or is not a console key → ask for a read/write Console key |
| `font` / `python venv` ✗ | rerun `npm run setup` (needs network to GitHub and PyPI) |

## 5. Smoke test, then the real run / 冒烟测试，然后正式运行

```bash
# ~1 minute, a few cents, no Statsig, no rendering
npm run loop -- --local --no-render --scale 0.2 --rounds 1 --set memory.write=false --run smoke

# the real thing (~20-30 min): seed round with 8 rendered + verified videos, 3 agent rounds on Statsig, final render
npm run loop
```

- **Progress:** it prints one line per step. The run directory is `runs/<run-id>/`. Open `runs/<run-id>/trace.html` in a browser when it finishes.
- **Interrupted?** Rerun with the same id: `npm run loop -- --run <run-id>`. Pi Durable resumes at the last committed phase, and finished work (images, renders, experiments, simulated looks) is never redone.
- **Human-in-the-loop:** the default is `review.mode=auto`. Add `--human` if the person wants to approve each proposal in the terminal.

## 6. Deliverables / 交付物

```bash
npm run eval   -- --run <run-id>   # agent vs baselines vs optimum (adds a section to trace.html)
npm run pulse  -- --run <run-id>   # later (hours): attach metrics + pull Statsig Pulse
npm run export -- --run <run-id>   # copies videos, manifests, trace, ledger to deliverables/<run-id>/
```

## 7. Rules for agents working in this repo / 在本仓库工作的规则

- Never print, log or commit secrets. `.env` and `config/local.json` are gitignored, and so are `runs/` and `cache/`.
- Don't hand-edit manifests in `runs/*/manifests/`. They are immutable; a change means a new variant with a `parent_id`.
- Layer values must exist in `data/catalog.json`, which is the CSV vocabulary. Adding a value means refitting (`npm run fit`) and giving the audience model a way to score it.
- Paid calls go through `src/llm.ts`, which writes them to the run's `ledger.jsonl` and enforces the budget. Keep it that way.
- Durable task phases (`src/durable/tasks.ts`) must stay idempotent: check for the output file before doing paid work, and commit a new checkpoint at the end of every phase. Never call Harness reads (`h.root()`, `h.conversation()`, …) inside a `commit()` callback; it deadlocks.
- After changing TypeScript, run `npm run typecheck`. After changing the renderer, render one variant: `npm run render -- --run <id> --variant <vid>`.
