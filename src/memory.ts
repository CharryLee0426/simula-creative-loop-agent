// Learnings and cross-run memory. The strategist states structured claims; deterministic code decides what the data
// says about them. A claim is checked only against clean contrasts: two arms of the same experiment that differ in
// exactly the claimed layer (same round = same traffic, every other layer held fixed). The LLM never sets a status.
//
// Cross-run memory (memory/playbook.json) keeps one entry per comparison (layer, two values, context, segment), pools
// its evidence over runs, words the statement from the pooled data, ranks entries by the lift that holds with 95%
// confidence, and moves statements the data no longer supports to memory/archive.json, where the agent never sees them.
import { join } from "node:path";
import { SEGMENTS, type AudienceModel, type Segment } from "./audience.ts";
import { PATHS } from "./config.ts";
import type { ArmResult, RoundResult } from "./experiment/analyze.ts";
import { isValidValue, LAYER_NAMES, layerValues, type LayerName, type Layers, type Manifest } from "./manifest.ts";
import { appendJsonl, readJsonIf, writeJson } from "./util/core.ts";

/** "similar" means the two values are within ±10% of each other. */
export const SIMILAR_MARGIN = 0.1;
/**
 * A local-optimum claim needs this share of one-layer neighbours compared head-to-head. 1.0 = all of them: with 60%,
 * runs stopped at a weak optimum whose one better neighbour was among the untested 40% (see the multi-seed comparison).
 */
export const OPTIMUM_COVERAGE = 1.0;
/** "Local optimum" means no one-layer change beats it by more than this: smaller gaps are not measurable here. */
export const OPTIMUM_TOLERANCE = 0.05;
export const MAX_LEARNINGS = 10;
/** Open (unresolved) memory entries without new evidence for this many runs expire. */
export const OPEN_TTL_RUNS = 3;
const Z = 1.96;

export type SegmentOrAll = Segment | "all";
export type EffectClaim = { id: string; kind: "effect"; layer: LayerName; value: string; vs: string; relation: "better" | "similar"; context?: Partial<Layers>; segment?: SegmentOrAll; note?: string };
export type OptimumClaim = { id: string; kind: "optimum"; variant_id: string; note?: string };
export type Claim = EffectClaim | OptimumClaim;

export type Verdict = "supported" | "refuted" | "open" | "unverified";
export type Contrast = { round: number; a: string; b: string; log_ratio: number; se: number };
export type Learning = Claim & {
	text: string;
	status: Verdict;
	/** effect: pooled relative lift of `value` over `vs` (e.g. 0.12 = +12%) and its 95% CI. */
	effect?: number;
	ci?: [number, number];
	contrasts?: Contrast[];
	/** optimum: neighbours compared head-to-head / all one-layer neighbours, and those that scored higher. */
	coverage?: { compared: number; total: number; higher: { variant_id: string; lift: number }[] };
	reason: string;
};

const sgn = (x: number) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(0)}%`;
const ctxText = (ctx?: Partial<Layers>) => (ctx && Object.keys(ctx).length ? ` [when ${Object.entries(ctx).map(([k, v]) => `${k}=${v}`).join(", ")}]` : "");
const segText = (s?: SegmentOrAll) => (s && s !== "all" ? ` (${s} segment)` : "");

export function claimText(c: Claim): string {
	if (c.kind === "optimum") return `${c.variant_id} is a local optimum (no one-layer change beats it by more than ${100 * OPTIMUM_TOLERANCE}%)`;
	return `${c.layer}: ${c.value} ${c.relation === "better" ? ">" : "≈"} ${c.vs}${ctxText(c.context)}${segText(c.segment)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// validation (shared by submit_generation and submit_learnings)
// ---------------------------------------------------------------------------------------------------------------

/** Checks shape and catalog values; returns normalized claims. Tested = variant ids with a recorded result. */
export function validateClaims(raw: unknown, tested: Set<string>): { claims: Claim[]; errors: string[] } {
	const errors: string[] = [];
	const claims: Claim[] = [];
	if (raw === undefined || raw === null) return { claims, errors };
	if (!Array.isArray(raw)) return { claims, errors: ["learnings: must be an array of structured claims"] };
	if (raw.length > MAX_LEARNINGS) errors.push(`learnings: at most ${MAX_LEARNINGS} (got ${raw.length}); keep the ones that matter most`);
	const seen = new Set<string>();
	raw.forEach((x: any, i: number) => {
		const tag = `learnings[${i}]${x?.id ? ` (${x.id})` : ""}`;
		const id = String(x?.id ?? `L${i + 1}`);
		if (x?.kind === "optimum") {
			if (!tested.has(x.variant_id)) { errors.push(`${tag}: optimum claim needs variant_id of a tested variant (got "${x.variant_id}")`); return; }
			const c: OptimumClaim = { id, kind: "optimum", variant_id: x.variant_id, ...(x.note ? { note: String(x.note) } : {}) };
			const k = claimText(c);
			if (seen.has(k)) errors.push(`${tag}: duplicate of another claim`);
			seen.add(k);
			claims.push(c);
			return;
		}
		if (x?.kind !== "effect") { errors.push(`${tag}: kind must be "effect" or "optimum" (one claim = one layer; split compound claims)`); return; }
		const layer = x.layer as LayerName;
		if (!LAYER_NAMES.includes(layer)) { errors.push(`${tag}: layer must be one of ${LAYER_NAMES.join(", ")}`); return; }
		const bad: string[] = [];
		for (const f of ["value", "vs"] as const) if (!isValidValue(layer, x[f])) bad.push(`${f}="${x[f]}" is not a ${layer} value (allowed: ${layerValues(layer).join(" | ")})`);
		if (bad.length) { errors.push(`${tag}: ${bad.join("; ")}`); return; }
		if (x.value === x.vs) { errors.push(`${tag}: value and vs are the same`); return; }
		if (x.relation !== "better" && x.relation !== "similar") { errors.push(`${tag}: relation must be "better" (value beats vs) or "similar" (within ±${100 * SIMILAR_MARGIN}%); to say value is worse, swap value and vs`); return; }
		const context: Partial<Layers> = {};
		for (const [k, v] of Object.entries<string>(x.context ?? {})) {
			if (!LAYER_NAMES.includes(k as LayerName)) { errors.push(`${tag}: context key "${k}" is not a layer`); continue; }
			if (k === layer) { errors.push(`${tag}: context cannot fix the claimed layer ${layer}`); continue; }
			if (!isValidValue(k as LayerName, v)) { errors.push(`${tag}: context ${k}="${v}" is not in the catalog`); continue; }
			context[k as LayerName] = v;
		}
		const segment: SegmentOrAll = x.segment ?? "all";
		if (segment !== "all" && !SEGMENTS.includes(segment as Segment)) { errors.push(`${tag}: segment must be all, ${SEGMENTS.join(", ")}`); return; }
		const c: EffectClaim = { id, kind: "effect", layer, value: x.value, vs: x.vs, relation: x.relation, ...(Object.keys(context).length ? { context } : {}), ...(segment !== "all" ? { segment } : {}), ...(x.note ? { note: String(x.note) } : {}) };
		const k = comparisonKey("", c);
		if (seen.has(k)) errors.push(`${tag}: duplicate of another claim about the same comparison`);
		seen.add(k);
		claims.push(c);
	});
	return { claims, errors };
}

// ---------------------------------------------------------------------------------------------------------------
// verification against clean contrasts
// ---------------------------------------------------------------------------------------------------------------

function rateOf(a: ArmResult, seg: SegmentOrAll): { ipm: number; seRel: number } | null {
	const x = seg === "all" ? { ipm: a.ipm, ci: a.ipm_ci } : { ipm: a.by_segment[seg].ipm, ci: a.by_segment[seg].ipm_ci };
	if (!(x.ipm > 0)) return null;
	const se = (x.ci[1] - x.ipm) / Z; // upper half: the lower bound is clipped at 0
	return se > 0 ? { ipm: x.ipm, seRel: se / x.ipm } : null;
}

const sameExcept = (x: Layers, y: Layers, layer: LayerName) => LAYER_NAMES.every((l) => l === layer || x[l] === y[l]);
const matches = (x: Layers, ctx?: Partial<Layers>) => Object.entries(ctx ?? {}).every(([k, v]) => x[k as LayerName] === v);

/** Every same-round pair of arms that differ only in `layer` (value vs other), as log ratios of ipm. */
export function findContrasts(results: RoundResult[], layer: LayerName, value: string, vs: string, ctx?: Partial<Layers>, seg: SegmentOrAll = "all"): Contrast[] {
	const out: Contrast[] = [];
	for (const r of results) for (const x of r.arms) {
		if (x.layers[layer] !== value || !matches(x.layers, ctx)) continue;
		for (const y of r.arms) {
			if (y.layers[layer] !== vs || !sameExcept(x.layers, y.layers, layer)) continue;
			const rx = rateOf(x, seg), ry = rateOf(y, seg);
			if (!rx || !ry) continue;
			out.push({ round: r.round, a: x.variant_id, b: y.variant_id, log_ratio: Math.log(rx.ipm / ry.ipm), se: Math.sqrt(rx.seRel ** 2 + ry.seRel ** 2) });
		}
	}
	return out;
}

/** Inverse-variance (fixed-effect) pooling of log ratios. */
export function pool(xs: { log_ratio: number; se: number }[]): { d: number; se: number } | null {
	const ws = xs.filter((x) => x.se > 0).map((x) => ({ w: 1 / x.se ** 2, d: x.log_ratio }));
	if (!ws.length) return null;
	const W = ws.reduce((s, x) => s + x.w, 0);
	return { d: ws.reduce((s, x) => s + x.w * x.d, 0) / W, se: 1 / Math.sqrt(W) };
}

function effectVerdict(relation: "better" | "similar", d: number, se: number): Verdict {
	const lo = d - Z * se, hi = d + Z * se;
	if (relation === "better") return lo > 0 ? "supported" : hi < 0 ? "refuted" : "open";
	const band: [number, number] = [Math.log(1 - SIMILAR_MARGIN), Math.log(1 + SIMILAR_MARGIN)];
	if (lo >= band[0] && hi <= band[1]) return "supported";
	if (lo > band[1] || hi < band[0]) return "refuted";
	return "open";
}

function scoreEffect(c: EffectClaim, results: RoundResult[]): Learning {
	const text = claimText(c);
	const contrasts = findContrasts(results, c.layer, c.value, c.vs, c.context, c.segment ?? "all");
	const p = pool(contrasts);
	if (!p) return { ...c, text, status: "unverified", contrasts: [], reason: `no clean contrast yet: needs two arms in one experiment that differ only in ${c.layer} (${c.value} vs ${c.vs})${c.context ? " within the claimed context" : ""}` };
	const status = effectVerdict(c.relation, p.d, p.se);
	const effect = Math.exp(p.d) - 1;
	const ci: [number, number] = [Math.exp(p.d - Z * p.se) - 1, Math.exp(p.d + Z * p.se) - 1];
	const why = status === "supported" ? (c.relation === "better" ? "CI above 0" : `CI inside ±${100 * SIMILAR_MARGIN}%`)
		: status === "refuted" ? (c.relation === "better" ? "CI below 0: the reverse holds" : `CI outside ±${100 * SIMILAR_MARGIN}%`)
		: c.relation === "better" ? "CI includes 0" : `CI not inside ±${100 * SIMILAR_MARGIN}%`;
	return { ...c, text, status, effect, ci, contrasts, reason: `${sgn(effect)} [${sgn(ci[0])}, ${sgn(ci[1])}] from ${contrasts.length} clean contrast(s); ${why}` };
}

function scoreOptimum(c: OptimumClaim, results: RoundResult[], manifests: Map<string, Manifest>, minCoverage = OPTIMUM_COVERAGE): Learning {
	const text = claimText(c);
	const m = manifests.get(c.variant_id);
	if (!m) return { ...c, text, status: "unverified", reason: `unknown variant ${c.variant_id}` };
	let total = 0, compared = 0;
	const higher: { variant_id: string; lift: number }[] = [];
	const tol = Math.log(1 + OPTIMUM_TOLERANCE);
	let refutedBy: string | undefined;
	let beyond = false;
	for (const l of LAYER_NAMES) for (const v of layerValues(l)) {
		if (v === m.layers[l]) continue;
		total++;
		// neighbour vs the claimed optimum, both arms in the same round with every other layer equal to the optimum's
		const ctx = Object.fromEntries(LAYER_NAMES.filter((k) => k !== l).map((k) => [k, m.layers[k]])) as Partial<Layers>;
		const p = pool(findContrasts(results, l, v, m.layers[l], ctx));
		if (!p) continue;
		compared++;
		const nb = [...manifests.values()].find((x) => x.layers[l] === v && sameExcept(x.layers, m.layers, l));
		const id = nb?.variant_id ?? `${l}=${v}`;
		if (p.d > 0) higher.push({ variant_id: id, lift: Math.exp(p.d) - 1 });
		if (p.d > tol) beyond = true;
		if (p.d - Z * p.se > tol) refutedBy = id;
	}
	const coverage = { compared, total, higher };
	const share = total ? compared / total : 0;
	const hi = higher.length ? `; directionally higher: ${higher.map((h) => `${h.variant_id} ${sgn(h.lift)}`).join(", ")}` : "";
	if (refutedBy) return { ...c, text, status: "refuted", coverage, reason: `${refutedBy} beats it by more than ${100 * OPTIMUM_TOLERANCE}% (CI)` };
	const cov = `${compared}/${total} one-layer neighbours compared head-to-head (${Math.round(100 * share)}%)`;
	if (share < minCoverage - 1e-9) {
		const missing = LAYER_NAMES.flatMap((l) => layerValues(l).filter((v) => v !== m.layers[l] && !pool(findContrasts(results, l, v, m.layers[l], Object.fromEntries(LAYER_NAMES.filter((k) => k !== l).map((k) => [k, m.layers[k]])) as Partial<Layers>))).map((v) => `${l}=${v}`));
		return { ...c, text, status: compared ? "open" : "unverified", coverage, reason: `${cov}, below the ${Math.round(100 * minCoverage)}% needed; not yet compared: ${missing.join(", ")}${hi}` };
	}
	if (beyond) return { ...c, text, status: "open", coverage, reason: `${cov}; a neighbour scored more than ${100 * OPTIMUM_TOLERANCE}% higher${hi}` };
	return { ...c, text, status: "supported", coverage, reason: `${cov}; none higher by more than ${100 * OPTIMUM_TOLERANCE}%${hi ? ` (within tolerance${hi})` : ""}` };
}

/**
 * Significant clean contrasts the agent has not claimed, pooled over every context (interactions possible), ranked by
 * the lift that holds with 95% confidence. Shown at the final reflection so memory is not limited to what it happened to claim.
 */
export function unclaimedContrasts(results: RoundResult[], claims: unknown[], k = 10): { layer: LayerName; winner: string; loser: string; lift: number; ci: [number, number]; n: number }[] {
	const claimed = new Set((claims ?? []).filter((c: any) => c?.kind === "effect").map((c: any) => `${c.layer}|${[c.value, c.vs].sort().join("~")}`));
	const out: { layer: LayerName; winner: string; loser: string; lift: number; ci: [number, number]; n: number }[] = [];
	for (const l of LAYER_NAMES) {
		const vals = layerValues(l);
		for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) {
			const [a, b] = [vals[i]!, vals[j]!];
			if (claimed.has(`${l}|${[a, b].sort().join("~")}`)) continue;
			const cs = findContrasts(results, l, a, b);
			const p = pool(cs);
			if (!p) continue;
			const lo = p.d - Z * p.se, hi = p.d + Z * p.se;
			if (lo > 0) out.push({ layer: l, winner: a, loser: b, lift: Math.exp(p.d) - 1, ci: [Math.exp(lo) - 1, Math.exp(hi) - 1], n: cs.length });
			else if (hi < 0) out.push({ layer: l, winner: b, loser: a, lift: Math.exp(-p.d) - 1, ci: [Math.exp(-hi) - 1, Math.exp(-lo) - 1], n: cs.length });
		}
	}
	return out.sort((x, y) => y.ci[0] - x.ci[0]).slice(0, k);
}

/**
 * The search has converged when the champion was kept as control for `hold_rounds` consecutive rounds and passes the
 * local-optimum check (enough one-layer neighbours compared head-to-head, none higher by more than the tolerance).
 */
export function checkConvergence(results: RoundResult[], manifests: Map<string, Manifest>, opts: { min_rounds: number; hold_rounds: number; coverage?: number }): { converged: boolean; why: string } {
	const last = results[results.length - 1];
	if (!last || last.round < opts.min_rounds) return { converged: false, why: `fewer than ${opts.min_rounds} rounds after the seed round` };
	const champ = last.winner;
	const tail = results.slice(-opts.hold_rounds);
	if (tail.length < opts.hold_rounds || !tail.every((r) => r.control === champ && r.winner === champ)) return { converged: false, why: `champion ${champ} has not been kept as control for ${opts.hold_rounds} consecutive rounds` };
	const opt = scoreOptimum({ id: "convergence", kind: "optimum", variant_id: champ }, results, manifests, opts.coverage ?? OPTIMUM_COVERAGE);
	if (opt.status !== "supported") return { converged: false, why: `local-optimum check ${opt.status}: ${opt.reason}` };
	return { converged: true, why: `champion ${champ} kept as control in rounds ${tail.map((r) => r.round).join(", ")}; ${opt.reason}` };
}

/** Code-assigned verdicts for every claim, from all results so far. Legacy free-text learnings pass through as unverified. */
export function scoreLearnings(claims: unknown[], results: RoundResult[], manifests: Map<string, Manifest>): Learning[] {
	return (claims ?? []).map((raw: any, i) => {
		if (raw?.kind === "effect") return scoreEffect(raw as EffectClaim, results);
		if (raw?.kind === "optimum") return scoreOptimum(raw as OptimumClaim, results, manifests);
		return { id: String(raw?.id ?? `L${i + 1}`), kind: "optimum", variant_id: "", text: String(raw?.text ?? ""), status: "unverified", reason: "legacy free-text learning (not checkable)" } as Learning;
	});
}

export function learningLine(l: Learning): string {
	const ev = (l.contrasts ?? []).slice(0, 3).map((x) => `r${x.round} ${x.a} vs ${x.b} ${sgn(Math.exp(x.log_ratio) - 1)}`).join("; ");
	return `- ${l.id} [${l.status}] ${l.text} — ${l.reason}${ev ? ` (${ev}${(l.contrasts?.length ?? 0) > 3 ? "; …" : ""})` : ""}`;
}

export function verdictCounts(ls: Learning[]): string {
	const n = (s: Verdict) => ls.filter((l) => l.status === s).length;
	return `${n("supported")} supported, ${n("refuted")} refuted, ${n("open")} open, ${n("unverified")} unverified`;
}

// ---------------------------------------------------------------------------------------------------------------
// cross-run memory
// ---------------------------------------------------------------------------------------------------------------

export type MemoryEvidence = { run_id: string; log_ratio: number; se: number; n_contrasts: number };
export type MemoryStatement = { relation: "better" | "similar" | "open"; winner?: string; loser?: string; lift: number; ci: [number, number] };
export type MemoryEntry = {
	key: string;
	campaign: string;
	layer: LayerName;
	/** canonical (alphabetical) order; evidence log ratios are a over b */
	a: string;
	b: string;
	context: Partial<Layers>;
	segment: SegmentOrAll;
	evidence: MemoryEvidence[];
	statement: MemoryStatement;
	text: string;
	first_run: string;
	last_evidence_run: string;
	score: number;
};
export type Playbook = { version: 2; updated_at: string; runs: string[]; entries: MemoryEntry[] };
type LegacyPlaybook = { campaigns?: { run_id: string; learnings: unknown[] }[] };

const playbookPath = (dir: string) => join(dir, "playbook.json");
const archivePath = (dir: string) => join(dir, "archive.jsonl");

function comparisonKey(campaign: string, c: EffectClaim): string {
	const [a, b] = [c.value, c.vs].sort();
	const ctx = Object.entries(c.context ?? {}).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k}=${v}`).join(",");
	return `${campaign}|${c.layer}|${a}~${b}|${ctx || "any"}|${c.segment ?? "all"}`;
}

/** Reads memory/playbook.json; a legacy (v1, free-text) playbook reads as empty and is archived on the next write. */
export function loadPlaybook(dir = PATHS.memory): { pb: Playbook; legacy?: LegacyPlaybook } {
	const raw = readJsonIf<any>(playbookPath(dir));
	if (raw?.version === 2) return { pb: raw as Playbook };
	const empty: Playbook = { version: 2, updated_at: new Date().toISOString(), runs: [], entries: [] };
	return raw?.campaigns ? { pb: empty, legacy: raw } : { pb: empty };
}

function statementOf(e: Pick<MemoryEntry, "a" | "b" | "evidence">): MemoryStatement {
	const p = pool(e.evidence)!;
	const lo = p.d - Z * p.se, hi = p.d + Z * p.se;
	const orient = (winner: string, loser: string, d: number, l: number, h: number): MemoryStatement =>
		({ relation: "better", winner, loser, lift: Math.exp(d) - 1, ci: [Math.exp(l) - 1, Math.exp(h) - 1] });
	if (lo > 0) return orient(e.a, e.b, p.d, lo, hi);
	if (hi < 0) return orient(e.b, e.a, -p.d, -hi, -lo);
	const lift = Math.exp(p.d) - 1, ci: [number, number] = [Math.exp(lo) - 1, Math.exp(hi) - 1];
	if (lo >= Math.log(1 - SIMILAR_MARGIN) && hi <= Math.log(1 + SIMILAR_MARGIN)) return { relation: "similar", lift, ci };
	return { relation: "open", lift, ci };
}

function entryText(e: Omit<MemoryEntry, "text" | "score">): string {
	const s = e.statement;
	const n = e.evidence.reduce((x, y) => x + y.n_contrasts, 0);
	const tail = `${n} contrast(s), ${e.evidence.length} run(s)${ctxText(e.context)}${segText(e.segment)}`;
	if (s.relation === "better") return `${e.layer}: ${s.winner} > ${s.loser} by ${sgn(s.lift)} [${sgn(s.ci[0])}, ${sgn(s.ci[1])}] — ${tail}`;
	if (s.relation === "similar") return `${e.layer}: ${e.a} ≈ ${e.b} (${sgn(s.lift)} [${sgn(s.ci[0])}, ${sgn(s.ci[1])}], within ±${100 * SIMILAR_MARGIN}%) — ${tail}`;
	return `${e.layer}: ${e.a} vs ${e.b} unresolved (${sgn(s.lift)} [${sgn(s.ci[0])}, ${sgn(s.ci[1])}]) — ${tail}`;
}

/** Ranking key: the lift that holds with 95% confidence (CI bound nearest 0), discounted by staleness and campaign. */
function entryScore(e: Omit<MemoryEntry, "score" | "text">, runs: string[], campaign: string): number {
	const stale = Math.max(0, runs.length - 1 - runs.indexOf(e.last_evidence_run));
	const w = 0.85 ** stale * (e.campaign === campaign ? 1 : 0.5);
	const s = e.statement;
	if (s.relation === "better") return w * s.ci[0];
	if (s.relation === "similar") return 0;
	return -1;
}

const sameStatement = (x: MemoryStatement, y: MemoryStatement) => x.relation === y.relation && x.winner === y.winner;

/**
 * Merge one run's verified learnings into the playbook. Each effect claim with clean contrasts contributes this run's
 * pooled log ratio to its comparison (replacing any earlier contribution of the same run, so re-running is safe).
 * Statements are re-derived from all evidence; a statement the evidence no longer supports is archived, and so are
 * open entries that saw no evidence for OPEN_TTL_RUNS runs.
 */
export function mergeIntoPlaybook(runId: string, campaign: string, learnings: Learning[], dir = PATHS.memory): { pb: Playbook; archived: number } {
	const { pb, legacy } = loadPlaybook(dir);
	const now = new Date().toISOString();
	let archived = 0;
	const archive = (reason: string, rec: object) => { appendJsonl(archivePath(dir), { archived_at: now, run_id: runId, reason, ...rec }); archived++; };
	if (legacy) for (const c of legacy.campaigns ?? []) archive("legacy free-text learnings: not checkable against data", { legacy: c });
	if (!pb.runs.includes(runId)) pb.runs.push(runId);
	const byKey = new Map(pb.entries.map((e) => [e.key, e]));
	for (const l of learnings) {
		if (l.kind !== "effect" || !l.contrasts?.length) continue;
		const p = pool(l.contrasts)!;
		const key = comparisonKey(campaign, l);
		const [a, b] = [l.value, l.vs].sort();
		const ev: MemoryEvidence = { run_id: runId, log_ratio: a === l.value ? p.d : -p.d, se: p.se, n_contrasts: l.contrasts.length };
		const prev = byKey.get(key);
		const base = prev ?? { key, campaign, layer: l.layer, a: a!, b: b!, context: l.context ?? {}, segment: l.segment ?? "all", evidence: [], first_run: runId } as unknown as MemoryEntry;
		base.evidence = [...base.evidence.filter((x) => x.run_id !== runId), ev];
		base.last_evidence_run = runId;
		const statement = statementOf(base);
		if (prev && prev.statement.relation !== "open" && !sameStatement(prev.statement, statement)) {
			const why = statement.relation === "better" && prev.statement.relation === "better" ? "refuted: pooled evidence now points the other way"
				: statement.relation === "open" ? "no longer supported: pooled CI now includes 0"
				: `superseded: evidence now says ${statement.relation}`;
			archive(why, { key, text: prev.text, statement: prev.statement });
		}
		base.statement = statement;
		byKey.set(key, base);
	}
	const entries: MemoryEntry[] = [];
	for (const e of byKey.values()) {
		const stale = pb.runs.length - 1 - pb.runs.indexOf(e.last_evidence_run);
		if (e.statement.relation === "open" && stale >= OPEN_TTL_RUNS) { archive(`expired: unresolved and no new evidence for ${stale} runs`, { key: e.key, text: e.text }); continue; }
		const text = entryText(e);
		entries.push({ ...e, text, score: entryScore(e, pb.runs, campaign) });
	}
	entries.sort((x, y) => y.score - x.score || x.key.localeCompare(y.key));
	const out: Playbook = { version: 2, updated_at: now, runs: pb.runs, entries };
	writeJson(playbookPath(dir), out);
	return { pb: out, archived };
}

/** What the next run's strategist sees: the top-k supported statements, ranked; open ones stay out of the prompt. */
export function playbookPrompt(campaign: string, k = 8, dir = PATHS.memory): string {
	const { pb } = loadPlaybook(dir);
	const top = pb.entries
		.filter((e) => e.statement.relation !== "open")
		.map((e) => ({ e, s: entryScore(e, pb.runs, campaign) }))
		.sort((x, y) => y.s - x.s)
		.slice(0, k);
	if (!top.length) return "";
	return `\nVerified lessons from previous runs (each checked by code against clean A/B contrasts and pooled across runs; ranked by the lift that holds with 95% confidence; they may not transfer to new contexts, so re-test what matters):\n${top.map(({ e }, i) => `${i + 1}. ${e.text}`).join("\n")}`;
}

// ---------------------------------------------------------------------------------------------------------------
// ground truth (offline eval only: the audience model is never shown to the agent)
// ---------------------------------------------------------------------------------------------------------------

/** True relative lift of value over vs, geometric mean over every catalog context that matches the claim. */
export function trueEffect(model: AudienceModel, format: Manifest["format"], c: Pick<EffectClaim, "layer" | "value" | "vs" | "context" | "segment">, cache = new Map<string, number>()): number {
	const seg = c.segment ?? "all";
	const ipm = (layers: Layers) => {
		const k = `${seg}|${LAYER_NAMES.map((l) => layers[l]).join("|")}`;
		let v = cache.get(k);
		if (v === undefined) {
			const x = model.expected(layers, format);
			v = seg === "all" ? x.ipm : x.by_segment[seg].ipm;
			cache.set(k, v);
		}
		return v;
	};
	const others = LAYER_NAMES.filter((l) => l !== c.layer);
	let sum = 0, n = 0;
	const walk = (i: number, acc: Partial<Layers>) => {
		if (i === others.length) {
			const x = { ...acc, [c.layer]: c.value } as Layers, y = { ...acc, [c.layer]: c.vs } as Layers;
			sum += Math.log(ipm(x) / ipm(y));
			n++;
			return;
		}
		const l = others[i]!;
		const fixed = c.context?.[l];
		for (const v of fixed ? [fixed] : layerValues(l)) walk(i + 1, { ...acc, [l]: v });
	};
	walk(0, {});
	return Math.exp(sum / n) - 1;
}

/** Is the claim true under the audience model? (effect: by direction / margin; optimum: no neighbour has higher true ipm) */
export function claimIsTrue(model: AudienceModel, format: Manifest["format"], c: Claim, manifests: Map<string, Manifest>, cache = new Map<string, number>()): { truth: boolean; true_effect?: number } {
	if (c.kind === "effect") {
		const e = trueEffect(model, format, c, cache);
		return { truth: c.relation === "better" ? e > 0 : Math.abs(e) <= SIMILAR_MARGIN, true_effect: e };
	}
	const m = manifests.get(c.variant_id);
	if (!m) return { truth: false };
	const base = model.expected(m.layers, format).ipm;
	for (const l of LAYER_NAMES) for (const v of layerValues(l)) {
		if (v !== m.layers[l] && model.expected({ ...m.layers, [l]: v }, format).ipm > base * (1 + OPTIMUM_TOLERANCE)) return { truth: false };
	}
	return { truth: true };
}
