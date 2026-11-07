# Simula Creative Loop Agent

[中文说明 → README.zh-CN.md](README.zh-CN.md) · [Setup guide for AI agents → AGENTS.md](AGENTS.md)

An autonomous loop for short video ads (campaign: **Rune Keepers**). It does four things:

1. Decomposes a creative into a **manifest** of swappable layers.
2. Renders **generation 0** into 9:16 MP4s, in English and Chinese, with AI-verified quality.
3. Runs every generation as an **A/B experiment in Statsig** against a **simulated audience** fitted on `creative_performance.csv`.
4. Lets an **LLM agent** read the results and write the next generation.

The orchestration runs on **Pi Durable**, so a crash or Ctrl-C resumes where it stopped.

```
                ┌──────────────────────── one round = one Statsig experiment ────────────────────────┐
 brief+catalog  │                                                                                    │
 history CSV ──▶│ ① strategist (LLM, Pi Durable conversation) ──▶ ② validator (code) ──▶ ③ review      │
                │        ▲                                          │ rejected → errors back   (auto/human)
                │        │                                          ▼                                 │
                │   ⑦ readout (code)  ◀── ⑥ simulated traffic ◀── ⑤ Statsig experiment ◀── ④ render*  │
                │   CIs, Holm, P(best)     (audience model,          (Console API +          (seed + final
                │   guardrail, segments     Statsig SDK assignment    server SDK)             only)
                └────────────────────────────────────────────────────────────────────────────────────┘
 * render = GPT Image 2.6 keyframes (cached per layer) → deterministic renderer → Muse Spark video review
            → reject + fix suggestions → redo (≤ 3) → best attempt if never verified
```

## Quickstart

```bash
git clone <this repo> && cd simula_creative_loop_agent
npm install
npm run setup        # interactive: checks ffmpeg/uv, asks for keys, builds the Python env, downloads the font, fits the audience model
npm run loop         # round 0 (8 seed variants rendered) + rounds 1..3 + final render + trace.html
```

Requirements: Node ≥ 22.19 (runs the TypeScript directly), `ffmpeg`/`ffprobe`, [`uv`](https://docs.astral.sh/uv/) (it brings its own Python 3.12). You also need keys:

- **OpenRouter key:** required. It covers the LLMs, image generation and video review.
- **Statsig keys:** a Server Secret key and a Console API key. Optional: without them, `--local` runs everything offline using the same hashing approach.

| command | what it does |
|---|---|
| `npm run loop` | the full loop (default 3 rounds after the seed round). Resume any run with `-- --run <id>` |
| `npm run loop -- --local --no-render --scale 0.2 --rounds 1 --set memory.write=false` | quick offline smoke test: no Statsig, no renders, a few cents, does not touch the cross-run playbook |
| `npm run round -- --round N --run <id>` | exactly one round (the "one command per round" deliverable) |
| `npm run render -- --run <id> --variant <vid>` | (re)render and verify one manifest |
| `npm run report -- --run <id>` | rebuild `trace.html` and `trajectory.md` |
| `npm run eval -- --run <id>` | offline evaluation vs. baselines and the catalog optimum |
| `npm run pulse -- --run <id>` | attach metrics and pull Statsig Pulse results once Statsig has computed them |
| `npm run conclude -- --run <id>` | write each round's readout back to Statsig: horizon = simulated traffic, decision = ship the winner |
| `npm run export -- --run <id>` | copy videos, manifests and the trace to `deliverables/<id>/` |
| `npm run doctor` | check tools, keys, model ids, and Statsig access |

Useful flags: `--human` (approve each proposal in the terminal), `--langs en,zh`, `--scale 0.25` (less traffic), `--no-render`, `--set models.image_quality=medium`, plus any config path via `--set key=value`.

## What happens in one run

| round | who | what |
|---|---|---|
| 0 | strategist | designs **generation 0**: 8 manifests that vary ≥ 3 layers, with a control that replicates the most-served historical creative. The prior is per-layer × segment rates from the CSV |
| 0 | code | renders the 8 variants **in parallel** (8 child durable tasks) in EN and 中文. Muse Spark checks each video against its manifest; failures go back with fix suggestions, up to 3 redos |
| 0..3 | code | creates the round's Statsig experiment (8 groups, parameter `variant_id`), simulates users, sends exposures and events, reads out the results |
| 1..3 | strategist | reads the results and keeps the champion as control. Proposes 7 challengers, each a child of a tested variant that changes 1–2 layers. Cites the numbers it relies on |
| final | code | renders and verifies the final champion (if it is not a seed variant), writes `trace.html`, updates the cross-run playbook |

Per your instructions, only generation 0 and the final winner are rendered. Experiments evaluate **manifests**, because the audience model scores layers, not pixels. Set `render.policy` to `"all"` to also render every intermediate generation.

## Design

### Manifest (Goal 1)

```json
{
  "schema_version": "1.0",
  "variant_id": "g1_v03", "generation": 1, "parent_id": "g0_v05", "created_round": 1,
  "format": { "aspect": "9:16", "duration_s": 6 },
  "layers": { "background": "moonlit_temple", "character": "Luna", "action": "draws_blade",
              "hook": "She remembers everything.", "cta": "Play Free", "audio": "none" },
  "creative_key": "3f9a1c0b2e", "hypothesis_id": "H2", "rationale": "..."
}
```

- **Layers map 1:1 onto CSV columns.** `background`, `character`→`subject_character`, `action`→`subject_action`, `hook`→`hook_text`, `cta`→`cta_text`, `audio`→`audio_style`. Values are restricted to the CSV vocabulary (`data/catalog.json`), so the audience model can score every manifest.
- **Locked format.** 9:16 at 6 s is the only combination in the data that is also renderable under the 5–10 s / 9:16 rule.
- **Immutable.** Any edit creates a new `variant_id` with a `parent_id`. "What changed" is always a layer-by-layer diff (`diffLayers`). `creative_key` (a content hash) detects re-tests of the same creative.
- **Rendering depends only on the layers it uses.** Keyframe 1 is keyed by background + character. Keyframe 2 is keyframe 1 + action (an edit with keyframe 1 as reference, so the character stays consistent). Changing only the hook, CTA or audio reuses both images and only re-renders text, music and the composite (about 6 s locally). The LLM writes only the on-screen line (EN must contain the hook verbatim), the tagline and the timing.
- **Gen-0 selection:** the agent mixes exploitation of strong historical values per segment with exploration, and includes the incumbent creative as control.

### Renderer + verification

`py/renderer/` is the provided rk-pipeline, adapted:

- It takes one job JSON per language and auto-fits/wraps text, since English lines are longer than Chinese ones.
- It adds a warm daylight style and synth presets for the four CSV audio styles (`low_drums`, `warm_piano`, `upbeat_synth`, and `none`, which is room tone plus SFX so a track still exists).
- It uses per-preset loudness targets.

`src/render/creative.ts`:

- **Keyframes:** OpenRouter Images API, `openai/gpt-image-2.6-sunburst`, the quality/detail tier, at `high` quality.
- **Plan:** written by Claude through pi-ai.
- **Spec gate:** `ffprobe` checks 5–10 s, 9:16, ≤ 1080×1920, H.264, and an audible audio track.
- **Video review:** `meta/muse-spark-1.3-contributor` receives the MP4 and checks background, character, action, the exact on-screen line, CTA text, end card and brand safety. It returns per-check verdicts and fix instructions targeted at `keyframe1 | keyframe2 | line | timing | endcard`.
- **Redos:** a failure triggers a redo. The planner gets the findings, and visual fixes are appended to the keyframe prompt, which busts that frame's cache. After 3 redos, the best-scoring attempt is kept and marked "best effort".
- **Reviewer glitches:** if the reviewer says it saw no video, that counts as a tooling glitch. The call is retried, then falls back to three still frames; it never counts against the creative.

### Simulated audience (Goal 2)

`py/audience/fit.py` fits a **two-stage ridge logistic model** on 120k impressions. Both penalties are chosen by 5-fold CV, and segment interactions get their own penalty.

- `P(click)` from layer effects + segment × layer interactions + OS + fatigue: `log(min(exposure_n, 50))` with a per-segment slope.
- `P(install | click)` from layer effects + segment × layer interactions (heavily shrunk) + OS.
- `P(install | no click)` is a per-segment constant (68 view-through installs).

Hold-out AUC is 0.65 for clicks and 0.65 for installs. Variant-level weighted correlation of predicted vs observed is 0.96 for CTR and 0.88 for install rate. Simulated users have a segment and OS drawn from the data's mix, and see the ad 1–10 times (the empirical distribution). No ad is served after an install.

### Experiments on Statsig (Goal 3)

- **Setup:** one round = one experiment `rk_<run>_r<N>` with `idType=userID`. Each arm is a group with parameter `variant_id`, at equal size and 100% allocation, with the control group set. Assignment comes from the **Statsig server SDK** (`getExperiment(user, exp).get("variant_id")`), which logs exposures. Outcomes are logged as events: `ad_impression` (value = impressions), `ad_click` and `app_install`.
- **Metrics:** the primary metric is **IPM** (installs per 1,000 impressions), a ratio metric with delta-method variance because users are the randomization unit. The guardrail is CTR, which must not drop more than 15% (with significance). The readout also reports P(best) from Beta posteriors and per-segment IPM.
- **How many impressions:** power analysis on the per-user install rate: 30% MDE, α = 0.05 Bonferroni over 7 comparisons, power 0.8. The base rate comes from history in round 0 and from the control's last readout afterwards, never from the audience model. It is capped at 20k users per arm (traffic is the scarce resource), and the trace reports the achievable MDE.
- **When to stop:** 4 looks with an O'Brien–Fleming boundary on leader vs control, plus P(best) ≥ 0.95. Otherwise the experiment stops at the full horizon.
- **Decision:** the champion is the guardrail-passing arm with the highest P(best). It is labeled *significant* only when it beats control after Holm correction; otherwise *directional*.
- **Pulse lag:** Statsig computes Pulse on its own schedule. The loop's decisions use the same events, read out locally, and `npm run pulse` attaches the metrics and stores Pulse results next to each round once they exist.
- **Closing the loop on Statsig:** after each readout the round writes back to its Statsig experiment:
  - The primary metric (`app_install`) and secondary metrics (`ad_click`, `ad_impression`) are attached once Statsig has ingested the events.
  - The planned horizon becomes the simulated traffic (`targetExposures`), replacing Statsig's 14-day default.
  - The readout is recorded as the experiment **decision**: ship the winning group, with IPM, CI, lift, Holm p and P(best) in the decision reason.

  The console then shows every round as a finished experiment. This is `experiment.conclude_on_platform`, on by default, and `npm run conclude -- --run <id>` backfills older runs.

### Agent (Goal 4)

- **Context:**
  - The system prompt holds the brief, the catalog, how experiments work, and the rules.
  - Each round, one message carries the last round's full table and every tested variant with CIs.
  - It also carries pooled layer evidence across experiments, the agent's own running **learnings** list, and any human feedback.
  - The strategist is one **Pi Durable conversation** for the whole run, so it also remembers its own earlier reasoning.
- **Tools:** `submit_generation` runs the deterministic validator. It checks that values are in the catalog, that each child changes 1–2 layers vs its parent, that nothing is a re-test, that the control has been tested, that gen-0 varies ≥ 3 layers, and that **cited numbers match the record**. It returns REJECTED with every error, or ACCEPTED and ends the run. A second tool, `inspect_variant`, gives lineage and per-segment results.
- **Human feedback:**
  - Default `review.mode=auto` trusts the AI gate.
  - `--human` asks for approval in the terminal; a free-text answer goes back to the agent, which revises.
  - Without stopping the loop, you can write notes into `runs/<id>/feedback.md`. They are injected into the next round once.
- **Evaluation:** `npm run eval` uses the audience model as ground truth (the agent never sees it). It brute-forces all 9,600 creatives for the optimum, scores the agent's final creative, and compares against random-search and one-layer-mutation baselines at the same traffic, plus a history-only heuristic.
- **Improvement over time:** the learnings list is the agent's memory between rounds. At the end of a run it is appended to `memory/playbook.json` and shown to the next run as a weak prior.

### Pi Durable harness

- **Task tree:** `src/durable/tasks.ts` defines three task kinds: `app.loop` → `app.round` (×4) → `app.video` (×8 in parallel, plus 1 for the final). Every phase commits a checkpoint, so killing the process and re-running `npm run loop -- --run <id>` continues from the last phase.
- **Idempotent phases:** each phase skips work whose output already exists in the run directory. That covers proposals, Statsig experiments (looked up by name), each simulated look, keyframes, renders and verdicts.
- **Storage:** `runs/<id>/harness.sqlite` holds the strategist conversation, tool calls and its token cost.

### Trace and cost

- **`runs/<id>/trace.html`** has an EN/中文 toggle and contains:
  - KPIs and an IPM-by-round chart
  - spend per round, broken down into strategist LLM, plan LLM, images and video review
  - per round: what the agent changed and why (hypotheses, layer diffs, rationale), the experiment and its sizing, and the full results table
  - the seed and final videos with their verification attempts, the agent's learnings, and the event log
- **Other outputs:** `trajectory.md` is the same in Markdown. `ledger.jsonl` records every paid call, and the budget guard (`budget_usd`, default $25) refuses a call that would cross the cap.

### Run directory

```
runs/<id>/  config.json  state.json  harness.sqlite  trace.jsonl  ledger.jsonl  trace.html  trajectory.md  eval.json
  manifests/<variant>.json
  rounds/r<N>/  prompt_*.json  proposal.json  validation_attempts.jsonl  experiment.json  sample_size.json  sim/look_*.json  results.json  pulse.json
  variants/<variant>/  <variant>_en.mp4  <variant>_zh.mp4  summary.json  a<k>/{plan,keyframes,verdict_en,verdict_zh,attempt}.json
cache/keyframes/<hash>.png (+ .json prompt)   shared across runs
```

## Productionization sketch (Goal 5)

- **Renders:** object storage keyed by content hash (manifest layers + plan + renderer version). Each layer asset also lives in a CAS (`keyframes/<hash>`), so one layer edit re-renders seconds, not minutes. A CDN serves renders. Manifests and plans live in a database table, versioned by `variant_id`/`parent_id`. The renderer version is part of the key.
- **Versioning:** manifests are immutable. Campaigns hold a pointer to the current champion set. Every experiment records the creative keys of its arms, so any result can be traced back to exact pixels.
- **Triggers:** a scheduler starts a new round per campaign on any of four signals:
  - the running experiment hits its sample size or stopping boundary
  - the champion's IPM decays below a fatigue threshold (rolling exposure-adjusted readout)
  - budget or calendar events
  - a human request
- **Running hundreds of campaigns:**
  - Each campaign is one durable session; Pi Durable on Cloudflare Durable Objects or Vercel Workflow gives one isolated, crash-safe actor per campaign.
  - Renders and reviews go to a GPU/worker queue with per-campaign budgets.
- **Human in the loop:** proposals land in a review queue (approve / edit / send back with notes). Brand-safety failures and "best effort" renders always need a human. Approval latency is tracked so auto-approve can be enabled per campaign once trust is earned.
- **Ad server:** each campaign is a Statsig **Layer**, with parameter `variant_id`, and each round is an experiment inside it. At serve time the ad server calls `getLayer(user, campaign).get("variant_id")` and fetches that render from the CDN. Exposures and outcomes flow back as events, and the winner ships by setting the layer default. With real traffic, the fitted simulator is replaced by live events. The same readout code runs on Statsig's results (Pulse or a warehouse export) instead of the local tally. A contextual bandit per segment can replace fixed-horizon A/B once enough creatives exist.

## Limitations and next steps

- The audience model only knows layer values seen in the data. New values (a new hook) would need a prior with uncertainty, for example a hierarchical model or LLM-estimated similarity to known values.
- One creative per experiment is served to all segments. Per-segment champions (segment-targeted serving) are visible in the readout and are the obvious next step.
- Within an experiment, impressions are assumed independent of other campaigns: no cross-creative fatigue.
- Statsig Pulse lags, so in-loop decisions use the identical event stream read out locally.

## Repo map

| path | role |
|---|---|
| `src/cli.ts` | commands |
| `src/durable/` | Pi Durable harness + loop/round/video tasks |
| `src/agent/` | strategist context, tools, validator |
| `src/experiment/` | Statsig + local platforms, simulator, readout |
| `src/render/creative.ts` | keyframes, plan, render, spec gate, video review |
| `src/audience.ts`, `src/stats.ts` | audience model at serve time, statistics |
| `src/report/html.ts`, `src/eval/offline.ts` | trace and evaluation |
| `py/audience/fit.py` | audience model fitting |
| `py/renderer/` | deterministic renderer (adapted from rk-pipeline) |
| `data/` | dataset and layer catalog |
| `models/` | fitted model + history summary |
| `deliverables/` | exported runs (videos, manifests, trace) |
