# Deliverables — run `rk-20261108-0730`

Open **[trace.html](trace.html)** in a browser (EN/中文 toggle) for the full trajectory with embedded videos; [trajectory.md](trajectory.md) is the same in Markdown.

Platform: statsig · rounds 0..3 · languages en, zh · models: strategist anthropic/claude-sonnet-5.5, images openai/gpt-image-2.6-sunburst (high), video review meta/muse-spark-1.3-contributor

Total API spend: **$0.56** (every call in [ledger.jsonl](ledger.jsonl)).

## Final creative

**g3_v01** — verified by the video model, score 100

- en: [variants/g3_v01/g3_v01_en.mp4](variants/g3_v01/g3_v01_en.mp4)
- zh: [variants/g3_v01/g3_v01_zh.mp4](variants/g3_v01/g3_v01_zh.mp4)

```json
{
  "schema_version": "1.0",
  "variant_id": "g3_v01",
  "generation": 3,
  "parent_id": "g2_v01",
  "created_round": 3,
  "format": {
    "aspect": "9:16",
    "duration_s": 6
  },
  "layers": {
    "background": "moonlit_temple",
    "character": "Rex",
    "action": "draws_blade",
    "hook": "Your party is waiting.",
    "cta": "Play Free",
    "audio": "low_drums"
  },
  "creative_key": "628d409934",
  "hypothesis_id": "h3",
  "rationale": "Rex fits the party hook"
}
```

## Generation 0 (seed) videos

| variant | layers | verified | en | zh |
|---|---|---|---|---|
| [g0_v01](manifests/g0_v01.json) | storm_battlefield / Mira / close_up_smile / Free gems every day / Claim Bonus / warm_piano | ✓ (a0) | [mp4](variants/g0_v01/g0_v01_en.mp4) | [mp4](variants/g0_v01/g0_v01_zh.mp4) |
| [g0_v02](manifests/g0_v02.json) | throne_room / Rex / draws_blade / Your party is waiting. / Play Free / low_drums | ✓ (a0) | [mp4](variants/g0_v02/g0_v02_en.mp4) | [mp4](variants/g0_v02/g0_v02_zh.mp4) |
| [g0_v03](manifests/g0_v03.json) | moonlit_temple / Luna / draws_blade / She remembers everything. / Play Free / none | ✓ (a0) | [mp4](variants/g0_v03/g0_v03_en.mp4) | [mp4](variants/g0_v03/g0_v03_zh.mp4) |
| [g0_v04](manifests/g0_v04.json) | neon_city / Kael / waves_to_camera / Your party is waiting. / Play Free / upbeat_synth | ✓ (a0) | [mp4](variants/g0_v04/g0_v04_en.mp4) | [mp4](variants/g0_v04/g0_v04_zh.mp4) |
| [g0_v05](manifests/g0_v05.json) | sunlit_meadow / Luna / opens_treasure / The ruins are calling / Install Now / none | ✓ (a0) | [mp4](variants/g0_v05/g0_v05_en.mp4) | [mp4](variants/g0_v05/g0_v05_zh.mp4) |
| [g0_v06](manifests/g0_v06.json) | moonlit_temple / Rex / casts_spell / Can you beat level 3? / Play Free / low_drums | ✓ (a0) | [mp4](variants/g0_v06/g0_v06_en.mp4) | [mp4](variants/g0_v06/g0_v06_zh.mp4) |
| [g0_v07](manifests/g0_v07.json) | neon_city / Mira / draws_blade / She remembers everything. / Install Now / none | ✓ (a0) | [mp4](variants/g0_v07/g0_v07_en.mp4) | [mp4](variants/g0_v07/g0_v07_zh.mp4) |
| [g0_v08](manifests/g0_v08.json) | throne_room / Kael / waves_to_camera / The ruins are calling / Play Free / upbeat_synth | ✓ (a0) | [mp4](variants/g0_v08/g0_v08_en.mp4) | [mp4](variants/g0_v08/g0_v08_zh.mp4) |

## Experiments

| round | experiment | arms | users | decision |
|---|---|---|---|---|
| 0 | [rk_rk-20261108-0730_r0](https://console.statsig.com/3yJFaFXqLinI6iLsBXJvO8/experiments/rk_rk-20261108-0730_r0) (statsig) | 8 | 160,000 | ship g0_v03: beats control by 305% (Holm p=0.000) |
| 1 | [rk_rk-20261108-0730_r1](https://console.statsig.com/3yJFaFXqLinI6iLsBXJvO8/experiments/rk_rk-20261108-0730_r1) (statsig) | 8 | 160,000 | ship g1_v06: beats control by 28% (Holm p=0.039) |
| 2 | [rk_rk-20261108-0730_r2](https://console.statsig.com/3yJFaFXqLinI6iLsBXJvO8/experiments/rk_rk-20261108-0730_r2) (statsig) | 8 | 160,000 | keep control: best challenger g2_v01 not convincing (+11%, P(best)=0.79 < 0.8, Holm p=1.000) |
| 3 | [rk_rk-20261108-0730_r3](https://console.statsig.com/3yJFaFXqLinI6iLsBXJvO8/experiments/rk_rk-20261108-0730_r3) (statsig) | 8 | 160,000 | promote g3_v01 as champion (directional: P(best)=0.89 ≥ 0.8, not significant vs control) |

## Offline evaluation (ground truth = audience model, never shown to the agent)

| policy | final true ipm | % of optimum |
|---|---|---|
| LLM agent (anthropic/claude-sonnet-5.5) | 11.00 | 88% |
| mutate-1 baseline (mean of 20) | 10.06 ± 1.15 | 79% |
| random-search baseline (mean of 20) | 8.20 ± 1.10 | 61% |
| history heuristic (no experiments) | 8.42 | 63% |
| round-0 control (no loop) | 2.41 | 6% |

Catalog optimum: moonlit_temple / Mira / draws_blade / Your party is waiting. / Play Free / upbeat_synth (true ipm 12.29).

Layout: `manifests/` every variant · `rounds/r<N>/` prompt, proposal, validation attempts, experiment, sample size, simulated looks, results, Pulse · `variants/<id>/` videos, per-attempt plan / keyframes / verdicts.

Statsig console screenshots (primary `app_install`, secondary `ad_click` / `ad_impression`, decision written back): [experiments_list.jpg](statsig_screenshots/experiments_list.jpg) · [r0_setup_metrics.jpg](statsig_screenshots/r0_setup_metrics.jpg) · [r1_setup_metrics.jpg](statsig_screenshots/r1_setup_metrics.jpg) · [r2_setup_metrics.jpg](statsig_screenshots/r2_setup_metrics.jpg) · [r3_setup_metrics.jpg](statsig_screenshots/r3_setup_metrics.jpg) · [r3_duration_target.jpg](statsig_screenshots/r3_duration_target.jpg)

Figures used in the write-up (PNG + SVG sources): [figures/](figures/) (architecture, render cache, productionization, IPM by round, champion trajectory, segments, layer effects, eval vs baselines, spend, seed contact sheet, final champion frames).
