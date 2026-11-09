// The strategist as a Pi Durable extension: a system-prompt section plus three tools. submit_generation runs the
// validator; on success it writes the manifests and ends the agent run (terminate), on failure the agent sees the
// errors and retries in the same run.
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SEGMENTS } from "../audience.ts";
import { LAYER_NAMES, layerValues } from "../manifest.ts";
import { MAX_LEARNINGS, SIMILAR_MARGIN, validateClaims } from "../memory.ts";
import { allManifests, loadState, rc, roundResults } from "../runtime.ts";
import { appendJsonl, writeJson } from "../util/core.ts";
import { systemPrompt } from "./context.ts";
import { validateProposal, type Proposal } from "./validator.ts";

const layerSchema = () => ({
	type: "object",
	properties: Object.fromEntries(LAYER_NAMES.map((l) => [l, { type: "string", enum: layerValues(l) }])),
	additionalProperties: false,
});

/** Structured claims: one layer, two values, a relation; code (src/memory.ts) decides supported / refuted / open. */
export const learningsSchema = () => ({
	type: "array",
	maxItems: MAX_LEARNINGS,
	description: `Your running list of claims (max ${MAX_LEARNINGS}); it replaces the previous list. Do not set a status: code checks each claim against clean contrasts and shows you the verdict.`,
	items: {
		type: "object",
		properties: {
			id: { type: "string" },
			kind: { type: "string", enum: ["effect", "optimum"], description: "effect: one layer, value vs another value. optimum: a variant no one-layer change beats." },
			layer: { type: "string", enum: [...LAYER_NAMES], description: "effect: the single layer the claim is about" },
			value: { type: "string", description: "effect: the layer value you claim is better (or about equal)" },
			vs: { type: "string", description: "effect: the value it is compared with (same layer)" },
			relation: { type: "string", enum: ["better", "similar"], description: `better: value beats vs. similar: within ±${100 * SIMILAR_MARGIN}%. To say value is worse, swap value and vs.` },
			context: { ...layerSchema(), description: "effect, optional: other layers that must hold for the claim, e.g. {\"background\": \"moonlit_temple\"}. Omit for a general claim." },
			segment: { type: "string", enum: ["all", ...SEGMENTS], description: "effect, optional: all (default, traffic-weighted ipm) or one segment" },
			variant_id: { type: "string", description: "optimum: the tested variant you claim is a local optimum" },
			note: { type: "string" },
		},
		required: ["id", "kind"],
	},
});

export function submitGenerationTool() {
	return defineTool({
		name: "submit_generation",
		description: "Submit the next generation of manifests for this round's experiment. Returns ACCEPTED with the assigned variant ids, or REJECTED with every problem to fix.",
		parameters: {
			type: "object",
			properties: {
				round: { type: "integer" },
				summary: { type: "string", description: "2-4 sentences: what you learned from the last results and what this generation tests" },
				hypotheses: { type: "array", items: { type: "object", properties: { id: { type: "string" }, statement: { type: "string" } }, required: ["id", "statement"] } },
				control_variant_id: { type: "string", description: "rounds >= 1: the tested variant kept as control (normally the champion)" },
				control_index: { type: "integer", description: "round 0 only: index into variants of the control arm" },
				variants: {
					type: "array",
					items: {
						type: "object",
						properties: {
							parent_id: { type: ["string", "null"] },
							layers: { ...layerSchema(), description: "round 0: all six layers" },
							changes: { ...layerSchema(), description: "rounds >= 1: only the layers that differ from parent" },
							hypothesis_id: { type: "string" },
							rationale: { type: "string" },
							replicate: { type: "boolean" },
						},
						required: ["rationale"],
					},
				},
				learnings: learningsSchema(),
				evidence: {
					type: "array",
					items: { type: "object", properties: { variant_id: { type: "string" }, round: { type: "integer" }, metric: { type: "string", enum: ["ipm", "ctr"] }, value: { type: "number" } }, required: ["variant_id", "round", "metric", "value"] },
				},
			},
			required: ["round", "summary", "variants"],
		} as any,
		execute: async (args: unknown) => {
			const r = rc();
			const p = args as Proposal;
			const round = Number(p.round);
			if (round > r.cfg.rounds || loadState(r.paths).stopped_early || existsSync(join(r.paths.round(round), "results.json"))) {
				return { output: [{ type: "text" as const, text: `REJECTED. Round ${round} is not open for proposals (the experiments are over or this round already has results). If you were asked for the final reflection, call submit_learnings.` }], isError: true };
			}
			const manifests = allManifests(r.paths);
			const results = roundResults(r.paths).filter((x) => x.round < round);
			const state = loadState(r.paths);
			const v = validateProposal(p, { round, cfg: r.cfg, manifests, results, champion: state.champion });
			appendJsonl(join(r.paths.round(round), "validation_attempts.jsonl"), { ts: new Date().toISOString(), ok: v.ok, errors: v.errors, warnings: v.warnings });
			r.trace.emit(round, "validation", v.ok ? `proposal accepted (${v.manifests.length} new variants${v.warnings.length ? `, ${v.warnings.length} warnings` : ""})` : `proposal rejected: ${v.errors.length} problems`, { errors: v.errors, warnings: v.warnings });
			if (!v.ok) {
				return { output: [{ type: "text" as const, text: `REJECTED. Fix all of these and call submit_generation again:\n- ${v.errors.join("\n- ")}` }], isError: true };
			}
			for (const m of v.manifests) writeJson(r.paths.manifest(m.variant_id), m);
			writeJson(join(r.paths.round(round), "proposal.json"), { ...p, accepted_at: new Date().toISOString(), control: v.control, variant_ids: v.manifests.map((m) => m.variant_id), diffs: v.diffs, warnings: v.warnings });
			return {
				output: [{ type: "text" as const, text: `ACCEPTED. Control: ${v.control}. New variants: ${v.manifests.map((m) => `${m.variant_id} (${v.diffs[m.variant_id]})`).join("; ")}.${v.warnings.length ? ` Warnings: ${v.warnings.join("; ")}` : ""}` }],
				control: { terminate: true },
			};
		},
	});
}

export function inspectVariantTool() {
	return defineTool({
		name: "inspect_variant",
		description: "Full record for one tested variant: manifest, lineage and per-round results including per-segment ipm with CIs.",
		parameters: { type: "object", properties: { variant_id: { type: "string" } }, required: ["variant_id"] } as any,
		execute: async (args: unknown) => {
			const r = rc();
			const id = (args as { variant_id: string }).variant_id;
			const manifests = allManifests(r.paths);
			const m = manifests.get(id);
			if (!m) return { output: [{ type: "text" as const, text: `unknown variant ${id}` }], isError: true };
			const lineage: string[] = [];
			for (let cur: typeof m | undefined = m; cur; cur = cur.parent_id ? manifests.get(cur.parent_id) : undefined) lineage.push(cur.variant_id);
			const res = roundResults(r.paths).flatMap((x) => x.arms.filter((a) => a.variant_id === id).map((a) => ({ round: x.round, ...a })));
			return { output: [{ type: "text" as const, text: JSON.stringify({ manifest: m, lineage, results: res }, null, 1) }] };
		},
	});
}

export const reflectionPath = () => join(rc().paths.dir, "reflection.json");

/** Final reflection after the last experiment: the strategist restates its learnings with every result in view. */
export function submitLearningsTool() {
	return defineTool({
		name: "submit_learnings",
		description: "Only after the final round, when asked for the final reflection: submit your final learnings as structured claims. Code verifies each one; only supported claims enter cross-run memory.",
		parameters: {
			type: "object",
			properties: {
				summary: { type: "string", description: "2-4 sentences: what this run established" },
				learnings: learningsSchema(),
			},
			required: ["learnings"],
		} as any,
		execute: async (args: unknown) => {
			const r = rc();
			const a = args as { summary?: string; learnings?: unknown[] };
			if (!existsSync(join(r.paths.round(r.cfg.rounds), "results.json")) && !loadState(r.paths).stopped_early) {
				return { output: [{ type: "text" as const, text: "REJECTED. submit_learnings is only for the final reflection after the last round; this round needs submit_generation." }], isError: true };
			}
			const tested = new Set(roundResults(r.paths).flatMap((x) => x.arms.map((arm) => arm.variant_id)));
			const v = validateClaims(a.learnings, tested);
			if (!a.learnings?.length) v.errors.push("learnings: give at least one claim");
			appendJsonl(join(r.paths.dir, "reflection_attempts.jsonl"), { ts: new Date().toISOString(), ok: !v.errors.length, errors: v.errors });
			if (v.errors.length) return { output: [{ type: "text" as const, text: `REJECTED. Fix all of these and call submit_learnings again:\n- ${v.errors.join("\n- ")}` }], isError: true };
			writeJson(reflectionPath(), { summary: a.summary ?? "", learnings: v.claims, accepted_at: new Date().toISOString() });
			return { output: [{ type: "text" as const, text: `ACCEPTED. ${v.claims.length} claims recorded; code will verify them.` }], control: { terminate: true } };
		},
	});
}

export function strategistExtension() {
	return defineExtension({
		name: "creative-strategist",
		sections: [section("strategist", () => systemPrompt(rc().cfg), { tag: false })],
		tools: [submitGenerationTool(), inspectVariantTool(), submitLearningsTool()],
	});
}
