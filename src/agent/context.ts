// What the strategist sees. Static part (brief, catalog, rules) is the system prompt; each round gets one message
// with compact tables: last results, every tested variant, pooled layer evidence, learnings, human feedback.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { PATHS, type Config } from "../config.ts";
import { SEGMENTS } from "../audience.ts";
import type { RoundResult } from "../experiment/analyze.ts";
import { catalog, LAYER_NAMES, type Manifest } from "../manifest.ts";
import { learningLine, MAX_LEARNINGS, OPTIMUM_COVERAGE, OPTIMUM_TOLERANCE, playbookPrompt, SIMILAR_MARGIN, unclaimedContrasts, type Learning } from "../memory.ts";
import type { RunState } from "../runtime.ts";
import { readJsonIf } from "../util/core.ts";

const f1 = (x: number) => x.toFixed(2);
const pct = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${(100 * x).toFixed(0)}%`);

export function systemPrompt(cfg: Config): string {
	const cat = catalog();
	const layerLines = LAYER_NAMES.map((l) => {
		const vals = Object.entries(cat.layers[l] as Record<string, { en: string }>).map(([k]) => `"${k}"`);
		return `- ${l}: ${vals.join(", ")}`;
	}).join("\n");
	const chars = Object.entries(cat.layers.character).map(([k, v]) => `- ${k}: ${v.visual}. Voice: ${v.voice}.`).join("\n");
	return `You are the creative strategist in Simula's automated creative loop for the mobile game "${cat.brand.game.en}".
You design video-ad variants as manifests (one value per layer), read A/B test results, and decide the next generation.
Everything else — rendering, experiment setup in Statsig, traffic, statistics — is done by deterministic code.

CAMPAIGN BRIEF
Rune Keepers is a free-to-play mobile companion RPG: the player recruits AI characters into a party, chats with them between quests and fights alongside them. Ads run inside AI companion apps, RPG chat apps and casual games. Tone: warm and a little dramatic; no gore, no sexual content; every ad ends on an install CTA.
Characters:
${chars}
Audience segments (share of traffic): rpg (fantasy RPG / adventure chat apps, ~45%), companion (AI companion / relationship chat apps, ~36%), casual (casual puzzle / idle games, ~20%). One creative is served to all segments in an experiment.

LAYERS (only these exact values exist; format is fixed at 9:16, ${cfg.render.duration_s}s)
${layerLines}
The hook is the opening line the character says on screen; the cta is the end-card button text.

EXPERIMENTS
- One round = one Statsig experiment with ${cfg.experiment.arms} arms, users split evenly. Round 0 tests generation 0 (${cfg.experiment.arms} new variants). Every later round = the control (usually the current champion) + ${cfg.experiment.arms - 1} challengers.
- Primary metric: ipm = installs per 1000 impressions (higher is better). Guardrail: CTR must not drop more than ${Math.round(cfg.experiment.guardrail_ctr_drop * 100)}% vs control.
- Results are noisy: installs are rare (a few per thousand impressions) and each arm gets limited traffic. Read confidence intervals, Holm-adjusted p-values (p_adj) and P(best) — not just point estimates. A difference inside overlapping CIs is weak evidence.
- Champion rule (code): a challenger replaces the control only if it beats it significantly (Holm) or has P(best) ≥ ${cfg.experiment.promote_min_pbest ?? 0.8}; otherwise the control stays champion. You may still pick any tested variant as the next control.${cfg.convergence?.stop ? `
- Convergence (code): the loop ends before round ${cfg.rounds} once the champion has been kept as control for ${cfg.convergence.hold_rounds} consecutive rounds and passes the local-optimum check above. Completing the champion's one-layer neighbourhood is how a converged search is confirmed.` : ""}
- Winner's curse: the top arm of an experiment is usually overestimated (it won partly by luck, more so when the test stopped early). Expect it to regress toward the mean when re-tested as control; judge it by its CI, not its point estimate.
- Users see an ad 1-10 times; repeated exposure lowers response (fatigue). This is part of the simulated world, not something a manifest controls.

HOW TO PROPOSE
- Call the tool submit_generation exactly once per round with your full proposal. If it returns REJECTED, fix every listed problem and call it again.
- Round 0: give full layers for each of the ${cfg.experiment.arms} variants, vary at least 3 layers across the set, and set control_index (a sensible control is a replica of the historically most-served creative).
- Later rounds: set control_variant_id (normally the current champion) and give ${cfg.experiment.arms - 1} challengers, each with a parent_id (any tested variant) and "changes" touching 1-${cfg.experiment.max_layers_changed} layers, so each result says something about specific layers. Do not re-test identical creatives (at most one deliberate replicate with replicate: true).
- Balance exploitation (refine the best creative) and exploration (layer values with little or contradictory evidence). Think about segment-specific effects: a layer that wins in one segment may lose in another, and only the traffic-weighted total counts.
- Each challenger gets a hypothesis_id from your hypotheses list and a one-line rationale.
- In "evidence", cite the exact recorded numbers you rely on (variant_id, round, metric "ipm" in per mille or "ctr" in percent, value). The validator rejects numbers that do not match the record.
- Keep "learnings" as a running list (max ${MAX_LEARNINGS}) of structured claims; each round's list replaces the previous one. It is your memory between rounds and, after the run, the source of cross-run memory.
  - kind "effect": ONE layer, value vs another value of that layer, relation "better" or "similar" (within ±${100 * SIMILAR_MARGIN}%). Add "context" (other layers held fixed) when the effect may depend on them, and "segment" for a single-segment claim. Never bundle several layers into one claim.
  - kind "optimum": a tested variant that no one-layer change beats.
  - You do not set a status. Code checks every claim against clean contrasts only (two arms of the same experiment that differ in exactly that layer), pools them and shows you the verdict with effect and CI: supported (CI on the claimed side), refuted (CI on the other side), open (CI too wide), unverified (no clean contrast yet). An optimum claim ("no one-layer change beats it by more than ${100 * OPTIMUM_TOLERANCE}%") needs ${OPTIMUM_COVERAGE >= 1 ? "every one" : `≥${Math.round(100 * OPTIMUM_COVERAGE)}%`} of its one-layer neighbours compared head-to-head (same experiment) and none scoring more than ${100 * OPTIMUM_TOLERANCE}% higher. Do not skip neighbours because a value looked weak elsewhere: values in a weak creative are confounded with its other layers.
  - Do not generalize past the evidence: a result for one value says nothing about the other values of that layer. If a claim matters for your decisions, design an arm that gives it a clean contrast.
- After the last round you will be asked for a final reflection: call submit_learnings once with your final list.`;
}

function historyBlock(): string {
	const h = readJsonIf<any>(PATHS.history);
	if (!h) return "(no historical data)";
	const lines: string[] = [];
	lines.push(`Historical serving data (2 weeks, ${h.totals.all.impressions} impressions, observational — confounded, use as a prior). ipm [95% CI] overall, then by segment:`);
	for (const l of LAYER_NAMES) {
		lines.push(`\n${l}:`);
		lines.push("| value | impressions | ipm all | rpg | companion | casual |\n|---|---|---|---|---|---|");
		for (const [v, row] of Object.entries<any>(h.layers[l])) {
			lines.push(`| ${v} | ${row.all.impressions} | ${f1(row.all.ipm)} [${f1(row.all.ipm_ci95[0])}, ${f1(row.all.ipm_ci95[1])}] | ${SEGMENTS.map((s) => `${f1(row[s].ipm)} (n=${row[s].impressions})`).join(" | ")} |`);
		}
	}
	const top = h.variants.slice(0, 5).map((v: any) => `${v.variant_id} (${v.impressions} imps, ipm ${f1(v.ipm)}): ${LAYER_NAMES.map((l) => v[l]).join(" / ")} [${v.aspect}, ${v.duration_s}s]`);
	lines.push(`\nMost-served historical creatives:\n- ${top.join("\n- ")}`);
	return lines.join("\n");
}

function playbookBlock(cfg: Config): string {
	if (cfg.memory?.read === false) return "";
	return playbookPrompt(cfg.campaign);
}

/** The running learnings list with the code-assigned verdicts (legacy free-text entries shown as they are). */
export function learningsBlock(ls: Learning[]): string {
	if (!ls.length) return "(none yet)";
	return ls.map((l) => ((l as any).reason ? learningLine(l) : `- ${l.id} (${l.status}) ${l.text}`)).join("\n");
}

function resultsTable(r: RoundResult, manifests: Map<string, Manifest>): string {
	const rows = r.arms.map((a) => {
		const m = manifests.get(a.variant_id)!;
		return `| ${a.variant_id}${a.is_control ? " (control)" : ""} | ${a.parent_id ?? "—"} | ${a.changed.join("+") || (a.is_control ? "—" : "new")} | ${LAYER_NAMES.map((l) => m.layers[l]).join(" / ")} | ${a.users} | ${a.impressions} | ${(100 * a.ctr).toFixed(2)}% | ${f1(a.ipm)} [${f1(a.ipm_ci[0])}, ${f1(a.ipm_ci[1])}] | ${pct(a.lift_vs_control)} | ${a.p_adj === null ? "—" : a.p_adj.toFixed(3)} | ${a.p_best.toFixed(2)} | ${SEGMENTS.map((s) => f1(a.by_segment[s].ipm)).join(" / ")} | ${a.guardrail_ok ? "ok" : "FAIL"} |`;
	});
	return `| arm | parent | changed | background / character / action / hook / cta / audio | users | imps | CTR | ipm [95% CI] | lift vs ctrl | p_adj | P(best) | ipm rpg / companion / casual | CTR guardrail |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}
Decision: ${r.decision}. Segment leaders: ${SEGMENTS.map((s) => `${s} → ${r.segment_winners[s]}`).join(", ")}.${r.stopped_early ? ` Stopped early after look ${r.looks_used}.` : ""}`;
}

function pooledLayers(results: RoundResult[]): string {
	const pool = new Map<string, { i: number; n: number; arms: number }>();
	for (const r of results) for (const a of r.arms) for (const l of LAYER_NAMES) {
		const k = `${l}=${a.layers[l]}`;
		const p = pool.get(k) ?? { i: 0, n: 0, arms: 0 };
		p.i += a.installs; p.n += a.impressions; p.arms++;
		pool.set(k, p);
	}
	const lines = LAYER_NAMES.map((l) => {
		const vals = [...pool.entries()].filter(([k]) => k.startsWith(`${l}=`)).sort((a, b) => b[1].i / b[1].n - a[1].i / a[1].n);
		return `- ${l}: ${vals.map(([k, p]) => `${k.split("=")[1]} ${f1((1000 * p.i) / p.n)} (${p.arms} arms)`).join("; ")}`;
	});
	return `Pooled across every arm tested so far (ipm of all arms containing the value; confounded by the other layers):\n${lines.join("\n")}`;
}

/** Consume runs/<id>/feedback.md (human notes between rounds) so it is shown exactly once. */
export function takeHumanFeedback(path: string, round: number): string {
	if (!existsSync(path)) return "";
	const text = readFileSync(path, "utf8").trim();
	renameSync(path, path.replace(/\.md$/, `.used_r${round}.md`));
	return text;
}

export function roundMessage(args: { cfg: Config; round: number; manifests: Map<string, Manifest>; results: RoundResult[]; state: RunState; feedback: string; budgetLeft: number }): string {
	const { cfg, round } = args;
	const last = round === cfg.rounds;
	const head = `ROUND ${round} of ${cfg.rounds} — pass round: ${round} to submit_generation. Budget left: $${args.budgetLeft.toFixed(2)}.`;
	const fb = args.feedback ? `\n\nHUMAN FEEDBACK (from the campaign manager; follow it unless it conflicts with brand safety):\n${args.feedback}` : "";
	if (round === 0) {
		return `${head}
Design generation 0: ${cfg.experiment.arms} variants for the first experiment. Mix exploitation of strong historical layer values (per segment) with exploration of under-served values. Combinations may be new or already in the data.

${historyBlock()}${playbookBlock(cfg)}${fb}`;
	}
	return `${head}
Current champion: ${args.state.champion}.${last ? "\nThis is the LAST experiment: its winner becomes the final creative that gets rendered. Favor exploitation; keep at most two exploratory arms." : ""}

${resultsContext(args)}

YOUR LEARNINGS SO FAR (verdicts computed by code from clean contrasts, including the round above):
${learningsBlock(args.state.learnings)}${fb}`;
}

/** Final reflection after the last experiment (no new variants): restate learnings with every result in view. */
export function reflectMessage(args: { cfg: Config; manifests: Map<string, Manifest>; results: RoundResult[]; state: RunState }): string {
	const cand = unclaimedContrasts(args.results, args.state.learnings);
	const sg = (x: number) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(0)}%`;
	const candBlock = cand.length
		? `\n\nSIGNIFICANT CLEAN CONTRASTS NOT IN YOUR LIST (mined by code over all experiments and pooled over contexts, so check for interactions; ranked by the lift that holds with 95% confidence). Add the ones a future run should know, replacing weaker claims if needed:\n${cand.map((c) => `- ${c.layer}: ${c.winner} > ${c.loser} ${sg(c.lift)} [${sg(c.ci[0])}, ${sg(c.ci[1])}] from ${c.n} contrast(s)`).join("\n")}`
		: "";
	return `FINAL REFLECTION — all ${args.results.length} experiments are done${args.state.stopped_early ? ` (the loop stopped early: ${args.state.stopped_early.reason})` : ""}. Final champion: ${args.state.champion}.
Do not propose variants. Call submit_learnings once with your final learnings (max ${MAX_LEARNINGS}): the claims a future run of this campaign should start from.
- Keep claims that the data supports, restate refuted ones in the direction the data shows, and drop what is still unverified unless it is your best guess for the next run.
- Prefer claims with clean contrasts; add context where the effect may depend on other layers. Code verifies every claim; only supported effect claims enter cross-run memory, ranked by the lift that holds with 95% confidence.

${resultsContext(args)}

YOUR LEARNINGS SO FAR (verdicts computed by code from clean contrasts, including the last round):
${learningsBlock(args.state.learnings)}${candBlock}`;
}

function resultsContext(args: { manifests: Map<string, Manifest>; results: RoundResult[] }): string {
	const prev = args.results[args.results.length - 1]!;
	const tested = new Map<string, { round: number; ipm: number; ci: [number, number]; n: number }>();
	for (const r of args.results) for (const a of r.arms) tested.set(`${a.variant_id}@r${r.round}`, { round: r.round, ipm: a.ipm, ci: a.ipm_ci, n: a.impressions });
	const testedRows = [...tested.entries()].map(([k, t]) => {
		const id = k.split("@")[0]!;
		const m = args.manifests.get(id)!;
		return `| ${id} | r${t.round} | ${m.parent_id ?? "—"} | ${LAYER_NAMES.map((l) => m.layers[l]).join(" / ")} | ${f1(t.ipm)} [${f1(t.ci[0])}, ${f1(t.ci[1])}] | ${t.n} |`;
	});
	return `RESULTS OF ROUND ${prev.round} (${prev.total_users} users, ${prev.total_impressions} impressions):
${resultsTable(prev, args.manifests)}

EVERY TESTED VARIANT (ipm per mille [95% CI], impressions):
| variant | round | parent | layers | ipm | imps |
|---|---|---|---|---|---|
${testedRows.join("\n")}

${pooledLayers(args.results)}`;
}
