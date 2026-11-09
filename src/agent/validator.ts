// Deterministic gate between the agent and the world: values must exist in the catalog (so the audience can score
// them), edits must be attributable (few layers per child), nothing already tested is re-run by accident, and every
// number the agent cites must match a recorded result.
import type { Config } from "../config.ts";
import type { RoundResult } from "../experiment/analyze.ts";
import { validateClaims } from "../memory.ts";
import { brandWarnings, creativeKey, diffLayers, isValidValue, LAYER_NAMES, layerValues, makeManifest, variantId, type Layers, type Manifest } from "../manifest.ts";

export type ProposalVariant = { parent_id?: string | null; layers?: Partial<Layers>; changes?: Partial<Layers>; hypothesis_id?: string; rationale?: string; replicate?: boolean };
export type Proposal = {
	round: number;
	summary: string;
	hypotheses?: { id: string; statement: string }[];
	control_variant_id?: string;
	control_index?: number;
	variants: ProposalVariant[];
	/** Structured claims (see src/memory.ts); code assigns their status. */
	learnings?: unknown[];
	evidence?: { variant_id: string; round: number; metric: "ipm" | "ctr"; value: number }[];
};

export type Validated = { ok: boolean; errors: string[]; warnings: string[]; manifests: Manifest[]; control: string; diffs: Record<string, string> };

export function validateProposal(p: Proposal, args: { round: number; cfg: Config; manifests: Map<string, Manifest>; results: RoundResult[]; champion?: string }): Validated {
	const errors: string[] = [];
	const warnings: string[] = [];
	const { round, cfg } = args;
	const format = { aspect: cfg.render.aspect, duration_s: cfg.render.duration_s } as Manifest["format"];
	const tested = new Map<string, string>(); // creative_key -> variant_id
	for (const r of args.results) for (const a of r.arms) {
		const m = args.manifests.get(a.variant_id);
		if (m) tested.set(m.creative_key, m.variant_id);
	}
	if (p.round !== undefined && p.round !== round) errors.push(`round must be ${round} (got ${p.round})`);
	if (!p.summary || p.summary.length < 20) errors.push("summary: explain in 2-4 sentences what you learned and what this generation tests");
	const hypIds = new Set((p.hypotheses ?? []).map((h) => h.id));
	const want = round === 0 ? cfg.experiment.arms : cfg.experiment.arms - 1;
	if (!Array.isArray(p.variants) || p.variants.length !== want) errors.push(`variants: need exactly ${want} (got ${p.variants?.length ?? 0})${round > 0 ? "; the control arm is added from control_variant_id" : ""}`);

	const manifests: Manifest[] = [];
	const diffs: Record<string, string> = {};
	const keys = new Set<string>();
	let replicates = 0;
	(p.variants ?? []).forEach((v, i) => {
		const tag = `variants[${i}]`;
		let layers: Partial<Layers>;
		let parent: Manifest | undefined;
		if (round === 0) {
			layers = v.layers ?? {};
		} else {
			parent = v.parent_id ? args.manifests.get(v.parent_id) : undefined;
			if (!parent) { errors.push(`${tag}: parent_id "${v.parent_id}" is not a tested variant`); return; }
			layers = { ...parent.layers, ...(v.layers ?? {}), ...(v.changes ?? {}) };
		}
		const missing = LAYER_NAMES.filter((l) => !layers[l]);
		if (missing.length) { errors.push(`${tag}: missing layers ${missing.join(", ")}`); return; }
		for (const l of LAYER_NAMES) if (!isValidValue(l, layers[l]!)) errors.push(`${tag}: ${l}="${layers[l]}" is not in the catalog (allowed: ${layerValues(l).join(" | ")})`);
		const full = layers as Layers;
		const key = creativeKey(full, format);
		if (keys.has(key)) errors.push(`${tag}: duplicates another variant in this proposal`);
		keys.add(key);
		if (tested.has(key)) {
			if (v.replicate && replicates === 0) { replicates++; warnings.push(`${tag}: replicate of already-tested ${tested.get(key)}`); }
			else errors.push(`${tag}: identical to already-tested ${tested.get(key)} (set replicate: true for at most one deliberate replicate)`);
		}
		if (parent) {
			const d = diffLayers(parent.layers, full);
			if (d.length === 0 && !v.replicate) errors.push(`${tag}: changes nothing vs parent ${parent.variant_id}`);
			if (d.length > cfg.experiment.max_layers_changed) errors.push(`${tag}: changes ${d.length} layers (${d.map((x) => x.layer).join(", ")}); max ${cfg.experiment.max_layers_changed} so the effect stays attributable`);
		}
		if (v.hypothesis_id && hypIds.size && !hypIds.has(v.hypothesis_id)) errors.push(`${tag}: hypothesis_id "${v.hypothesis_id}" is not in hypotheses`);
		for (const w of brandWarnings(full)) warnings.push(`${tag}: ${w}`);
		const id = variantId(round, i + 1);
		const m = makeManifest({ variant_id: id, generation: round, parent_id: parent?.variant_id ?? null, round, layers: full, format, hypothesis_id: v.hypothesis_id, rationale: v.rationale });
		manifests.push(m);
		diffs[id] = parent ? diffLayers(parent.layers, full).map((x) => `${x.layer}: ${x.from} → ${x.to}`).join("; ") : "(new)";
	});

	let control = "";
	if (round === 0) {
		const ci = p.control_index ?? 0;
		if (ci < 0 || ci >= manifests.length) errors.push(`control_index must be 0..${manifests.length - 1}`);
		else control = manifests[ci]?.variant_id ?? "";
		const varying = LAYER_NAMES.filter((l) => new Set(manifests.map((m) => m.layers[l])).size > 1);
		if (manifests.length && varying.length < 3) errors.push(`generation 0 must vary at least 3 layers across variants (varies: ${varying.join(", ") || "none"})`);
	} else {
		control = p.control_variant_id ?? args.champion ?? "";
		if (!args.manifests.has(control) || ![...tested.values()].includes(control)) errors.push(`control_variant_id "${control}" must be an already-tested variant (current champion: ${args.champion})`);
	}

	// learnings must be structured, one layer per claim, catalog values only; from round 1 the running list is required
	errors.push(...validateClaims(p.learnings, new Set(tested.values())).errors);
	if (round >= 1 && !p.learnings?.length) errors.push("learnings: give your running list of structured claims (at least one); it is your memory between rounds and the fallback if the final reflection fails");

	// citations must be real
	const byId = new Map<string, { round: number; ipm: number; ctr: number }>();
	for (const r of args.results) for (const a of r.arms) byId.set(`${r.round}:${a.variant_id}`, { round: r.round, ipm: a.ipm, ctr: a.ctr });
	for (const e of p.evidence ?? []) {
		const rec = byId.get(`${e.round}:${e.variant_id}`);
		if (!rec) { errors.push(`evidence: no result for ${e.variant_id} in round ${e.round}`); continue; }
		const actual = e.metric === "ctr" ? rec.ctr * 100 : rec.ipm;
		const tol = Math.max(0.06 * Math.abs(actual), e.metric === "ctr" ? 0.1 : 0.15);
		if (Math.abs(e.value - actual) > tol) errors.push(`evidence: ${e.variant_id} r${e.round} ${e.metric} cited ${e.value} but recorded ${actual.toFixed(3)}${e.metric === "ctr" ? "%" : " per mille"}`);
	}
	return { ok: errors.length === 0, errors, warnings, manifests, control, diffs };
}
