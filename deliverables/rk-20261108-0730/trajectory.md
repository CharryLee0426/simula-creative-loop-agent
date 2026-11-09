# Trajectory — run rk-20261108-0730

Final champion: **g3_v01** · total API spend $0.56 · platform statsig

## Round 0 — ship g0_v03: beats control by 305% (Holm p=0.000)

**Agent summary:** Round 0: control replicates the most-served creative; the other arms combine strong historical values and probe under-served ones.


| arm | change vs parent | ipm [95% CI] | lift | p_adj | P(best) |
|---|---|---|---|---|---|
| g0_v01 | control | 2.09 [1.58, 2.61] | — | — | 0.00 |
| g0_v02 | throne_room / Rex / draws_blade / Your party is waiting. / Play Free / low_drums | 8.02 [7.01, 9.04] | +283% | 0.000 | 0.25 |
| g0_v03 🏆 | moonlit_temple / Luna / draws_blade / She remembers everything. / Play Free / none | 8.49 [7.46, 9.52] | +305% | 0.000 | 0.70 |
| g0_v04 | neon_city / Kael / waves_to_camera / Your party is waiting. / Play Free / upbeat_synth | 7.08 [6.11, 8.04] | +238% | 0.000 | 0.01 |
| g0_v05 | sunlit_meadow / Luna / opens_treasure / The ruins are calling / Install Now / none | 5.00 [4.20, 5.81] | +139% | 0.000 | 0.00 |
| g0_v06 | moonlit_temple / Rex / casts_spell / Can you beat level 3? / Play Free / low_drums | 6.94 [6.00, 7.88] | +231% | 0.000 | 0.01 |
| g0_v07 | neon_city / Mira / draws_blade / She remembers everything. / Install Now / none | 7.36 [6.39, 8.34] | +252% | 0.000 | 0.03 |
| g0_v08 | throne_room / Kael / waves_to_camera / The ruins are calling / Play Free / upbeat_synth | 6.21 [5.32, 7.09] | +196% | 0.000 | 0.00 |

Cost: total $0.421 (strategist $0.030, plans $0.035, images $0.349, video review $0.0079)

## Round 1 — ship g1_v06: beats control by 28% (Holm p=0.039)

**Agent summary:** v03 champion. Test one-layer neighbours: background, character, action, hook, cta, audio.

- h1: One-layer changes to v03 can improve ipm

| arm | change vs parent | ipm [95% CI] | lift | p_adj | P(best) |
|---|---|---|---|---|---|
| g0_v03 | control | 7.49 [6.51, 8.48] | — | — | 0.00 |
| g1_v01 | background: moonlit_temple → throne_room | 6.88 [5.94, 7.82] | -8% | 1.000 | 0.00 |
| g1_v02 | character: Luna → Rex | 8.17 [7.14, 9.20] | +9% | 1.000 | 0.01 |
| g1_v03 | action: draws_blade → casts_spell | 7.04 [6.10, 7.99] | -6% | 1.000 | 0.00 |
| g1_v04 | hook: She remembers everything. → Your party is waiting. | 9.21 [8.12, 10.30] | +23% | 0.130 | 0.29 |
| g1_v05 | cta: Play Free → Install Now | 5.99 [5.12, 6.86] | -20% | 0.130 | 0.00 |
| g1_v06 🏆 | audio: none → low_drums | 9.59 [8.48, 10.71] | +28% | 0.039 | 0.65 |
| g1_v07 | background: moonlit_temple → neon_city | 8.55 [7.51, 9.60] | +14% | 0.593 | 0.04 |

Cost: total $0.046 (strategist $0.046, plans $0.000, images $0.000, video review $0.0000)

## Round 2 — keep control: best challenger g2_v01 not convincing (+11%, P(best)=0.79 < 0.8, Holm p=1.000)

**Agent summary:** g1_v06 (low_drums) is champion. Test the remaining one-layer neighbours and a combo of hook/background gains.

- h2: Neighbours of g1_v06 may improve; the party hook and neon background looked positive in round 1

| arm | change vs parent | ipm [95% CI] | lift | p_adj | P(best) |
|---|---|---|---|---|---|
| g1_v06 🏆 | control | 9.16 [8.08, 10.25] | — | — | 0.08 |
| g2_v01 | hook: She remembers everything. → Your party is waiting. | 10.15 [9.00, 11.29] | +11% | 1.000 | 0.79 |
| g2_v02 | background: moonlit_temple → neon_city | 9.04 [7.96, 10.12] | -1% | 1.000 | 0.06 |
| g2_v03 | character: Luna → Rex | 8.82 [7.75, 9.89] | -4% | 1.000 | 0.03 |
| g2_v04 | action: draws_blade → waves_to_camera | 8.81 [7.75, 9.87] | -4% | 1.000 | 0.03 |
| g2_v05 | audio: low_drums → upbeat_synth | 8.74 [7.69, 9.79] | -5% | 1.000 | 0.02 |
| g2_v06 | cta: Play Free → Join Luna | 6.33 [5.42, 7.25] | -31% | 0.001 | 0.00 |
| g2_v07 | background: moonlit_temple → neon_city; hook: She remembers everything. → Your party is waiting. | 8.12 [7.11, 9.13] | -11% | 1.000 | 0.00 |

Cost: total $0.021 (strategist $0.021, plans $0.000, images $0.000, video review $0.0000)

## Round 3 — promote g3_v01 as champion (directional: P(best)=0.89 ≥ 0.8, not significant vs control)

**Agent summary:** g2_v01 (party hook) is the best point estimate, strong in rpg. I'm using it as control and testing its one-layer neighbours. Two arms are exploratory.

- h3: Neighbours of g2_v01 may beat it; the weak companion segment may be lifted by background or action changes

| arm | change vs parent | ipm [95% CI] | lift | p_adj | P(best) |
|---|---|---|---|---|---|
| g2_v01 | control | 10.86 [9.68, 12.04] | — | — | 0.11 |
| g3_v01 🏆 | character: Luna → Rex | 11.94 [10.71, 13.17] | +10% | 0.258 | 0.89 |
| g3_v02 | action: draws_blade → waves_to_camera | 8.41 [7.37, 9.45] | -23% | 0.011 | 0.00 |
| g3_v03 | audio: low_drums → upbeat_synth | 9.60 [8.48, 10.72] | -12% | 0.258 | 0.00 |
| g3_v04 | background: moonlit_temple → throne_room | 7.38 [6.41, 8.36] | -32% | 0.000 | 0.00 |
| g3_v05 | action: draws_blade → casts_spell | 7.17 [6.21, 8.12] | -34% | 0.000 | 0.00 |
| g3_v06 | hook: Your party is waiting. → The ruins are calling | 8.93 [7.85, 10.00] | -18% | 0.070 | 0.00 |
| g3_v07 | character: Luna → Kael | 9.39 [8.28, 10.49] | -14% | 0.221 | 0.00 |

Cost: total $0.071 (strategist $0.066, plans $0.004, images $0.000, video review $0.0013)

Full interactive trace: trace.html