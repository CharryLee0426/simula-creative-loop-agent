// The strategist as a Pi Durable extension: a system-prompt section plus two tools. submit_generation runs the
// validator; on success it writes the manifests and ends the agent run (terminate), on failure the agent sees the
// errors and retries in the same run.
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { join } from "node:path";
import { LAYER_NAMES, layerValues } from "../manifest.ts";
import { allManifests, loadState, rc, roundResults } from "../runtime.ts";
import { appendJsonl, writeJson } from "../util/core.ts";
import { systemPrompt } from "./context.ts";
import { validateProposal, type Proposal } from "./validator.ts";

const layerSchema = () => ({
	type: "object",
	properties: Object.fromEntries(LAYER_NAMES.map((l) => [l, { type: "string", enum: layerValues(l) }])),
	additionalProperties: false,
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
				learnings: {
					type: "array",
					items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, status: { type: "string", enum: ["supported", "refuted", "open"] }, evidence: { type: "string" } }, required: ["id", "text", "status"] },
				},
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

export function strategistExtension() {
	return defineExtension({
		name: "creative-strategist",
		sections: [section("strategist", () => systemPrompt(rc().cfg), { tag: false })],
		tools: [submitGenerationTool(), inspectVariantTool()],
	});
}
