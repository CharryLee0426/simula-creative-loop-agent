# Trajectory — run rk-20261106-1124

Final champion: **g3_v05** · total API spend $0.86 · platform statsig

## Round 0 — ship g0_v04: beats control by 407% (Holm p=0.000)

**Agent summary:** Round 0: control is replica of most-served v_036; challengers mix strong historical values (Play Free, Your party is waiting, draws_blade, She remembers everything) across characters/backgrounds, with varied audio.

- h1: Play Free CTA + Your party is waiting hook is a strong combo for rpg
- h2: She remembers everything + Mira/Luna lifts companion
- h3: draws_blade and low_drums/none audio beat close_up_smile/warm_piano

| arm | change vs parent | ipm [95% CI] | lift | p_adj | P(best) |
|---|---|---|---|---|---|
| g0_v01 | control | 1.82 [1.14, 2.51] | — | — | 0.00 |
| g0_v02 | throne_room / Rex / draws_blade / Your party is waiting. / Play Free / low_drums | 6.73 [5.41, 8.05] | +269% | 0.000 | 0.01 |
| g0_v03 | moonlit_temple / Mira / waves_to_camera / She remembers everything. / Install Now / none | 6.81 [5.51, 8.11] | +273% | 0.000 | 0.01 |
| g0_v04 🏆 | neon_city / Luna / draws_blade / She remembers everything. / Play Free / upbeat_synth | 9.25 [7.71, 10.78] | +407% | 0.000 | 0.98 |
| g0_v05 | sunlit_meadow / Kael / opens_treasure / The ruins are calling / Play Free / none | 5.23 [4.07, 6.39] | +187% | 0.000 | 0.00 |
| g0_v06 | cozy_cafe / Luna / waves_to_camera / Can you beat level 3? / Install Now / low_drums | 5.28 [4.12, 6.45] | +190% | 0.000 | 0.00 |
| g0_v07 | neon_city / Rex / casts_spell / Your party is waiting. / Play Free / upbeat_synth | 6.70 [5.39, 8.01] | +267% | 0.000 | 0.01 |
| g0_v08 | moonlit_temple / Kael / draws_blade / The ruins are calling / Join Luna / none | 6.21 [4.96, 7.46] | +241% | 0.000 | 0.00 |

Cost: total $0.688 (strategist $0.018, plans $0.049, images $0.611, video review $0.0103)

## Round 1 — promote g1_v03 as champion (directional: P(best)=0.44, not significant vs control)

**Agent summary:** g0_v04 won (9.25). Refine it with single/double-layer changes: background, character, action, audio, cta, hook, and an rpg-oriented hook.

- h1: Background/audio tweaks of v04 keep or raise ipm
- h2: Hook 'Your party is waiting.' lifts rpg without hurting companion much
- h3: Character/action swaps keep Luna+blade synergy

| arm | change vs parent | ipm [95% CI] | lift | p_adj | P(best) |
|---|---|---|---|---|---|
| g0_v04 | control | 8.12 [7.09, 9.15] | — | — | 0.09 |
| g1_v01 | background: neon_city → moonlit_temple | 8.61 [7.55, 9.66] | +6% | 1.000 | 0.34 |
| g1_v02 | audio: upbeat_synth → none | 8.07 [7.05, 9.10] | -1% | 1.000 | 0.08 |
| g1_v03 🏆 | hook: She remembers everything. → Your party is waiting. | 8.72 [7.66, 9.78] | +7% | 1.000 | 0.44 |
| g1_v04 | character: Luna → Rex | 7.90 [6.89, 8.91] | -3% | 1.000 | 0.04 |
| g1_v05 | action: draws_blade → opens_treasure | 7.46 [6.49, 8.44] | -8% | 1.000 | 0.01 |
| g1_v06 | background: neon_city → throne_room; audio: upbeat_synth → low_drums | 7.58 [6.60, 8.57] | -7% | 1.000 | 0.01 |
| g1_v07 | cta: Play Free → Install Now | 6.99 [6.04, 7.93] | -14% | 0.778 | 0.00 |

Cost: total $0.032 (strategist $0.032, plans $0.000, images $0.000, video review $0.0000)

## Round 2 — ship g2_v01: beats control by 26% (Holm p=0.039)

**Agent summary:** Round 1 showed a plateau near 8-9 ipm. Hook, background and audio swaps were within noise. Play Free CTA mattered most (Install Now -14%), and draws_blade beat treasure. This round stacks the small gains (temple + party hook) and tests untried values, such as Join Luna with Luna, sunlit_meadow and casts_spell.

- h1: Temple background and Your party hook gains stack (both lifted rpg)
- h2: Join Luna CTA matches Luna and helps now that Luna is on screen
- h3: Untested action/background values may match draws_blade/neon
- h4: Play Free CTA and upbeat_synth remain best

| arm | change vs parent | ipm [95% CI] | lift | p_adj | P(best) |
|---|---|---|---|---|---|
| g1_v03 | control | 7.64 [6.66, 8.63] | — | — | 0.00 |
| g2_v01 🏆 | background: neon_city → moonlit_temple | 9.65 [8.55, 10.76] | +26% | 0.039 | 0.70 |
| g2_v02 | cta: Play Free → Join Luna | 5.81 [4.94, 6.67] | -24% | 0.037 | 0.00 |
| g2_v03 | action: draws_blade → casts_spell | 6.45 [5.55, 7.36] | -16% | 0.245 | 0.00 |
| g2_v04 | background: neon_city → sunlit_meadow | 6.97 [6.02, 7.92] | -9% | 0.676 | 0.00 |
| g2_v05 | character: Luna → Kael; audio: upbeat_synth → low_drums | 8.10 [7.08, 9.13] | +6% | 0.676 | 0.01 |
| g2_v06 | background: neon_city → moonlit_temple; hook: Your party is waiting. → The ruins are calling | 9.25 [8.16, 10.34] | +21% | 0.127 | 0.29 |
| g2_v07 | cta: Play Free → Claim Bonus | 5.51 [4.66, 6.35] | -28% | 0.009 | 0.00 |

Cost: total $0.021 (strategist $0.021, plans $0.000, images $0.000, video review $0.0000)

## Round 3 — promote g3_v05 as champion (directional: P(best)=0.88, not significant vs control)

**Agent summary:** g2_v01 (temple/Luna/blade/party/Play Free/synth) is champion at 9.65. Temple gains are consistent, mainly for rpg. The final round tests small exploitation tweaks of it, plus two exploratory arms. One arm is a deliberate replicate of g1_v01.

- h1: She remembers everything. hook with temple lifts companion without hurting rpg
- h2: Audio tweaks (none/low_drums) are neutral or slightly positive on temple
- h3: Different character/action on temple may lift

| arm | change vs parent | ipm [95% CI] | lift | p_adj | P(best) |
|---|---|---|---|---|---|
| g2_v01 | control | 9.35 [8.25, 10.45] | — | — | 0.02 |
| g3_v01 | hook: Your party is waiting. → She remembers everything. | 8.86 [7.80, 9.91] | -5% | 1.000 | 0.00 |
| g3_v02 | audio: upbeat_synth → low_drums | 9.84 [8.71, 10.96] | +5% | 1.000 | 0.08 |
| g3_v03 | audio: upbeat_synth → none | 8.90 [7.82, 9.97] | -5% | 1.000 | 0.00 |
| g3_v04 | character: Luna → Kael | 9.17 [8.09, 10.25] | -2% | 1.000 | 0.01 |
| g3_v05 🏆 | character: Luna → Rex | 10.96 [9.77, 12.15] | +17% | 0.359 | 0.88 |
| g3_v06 | cta: Play Free → Install Now | 8.61 [7.57, 9.66] | -8% | 1.000 | 0.00 |
| g3_v07 | action: draws_blade → waves_to_camera | 7.93 [6.93, 8.93] | -15% | 0.365 | 0.00 |

Cost: total $0.117 (strategist $0.034, plans $0.005, images $0.076, video review $0.0010)

Full interactive trace: trace.html