// Unit tests for verified learnings and cross-run memory (src/memory.ts). No model calls, no real memory/ directory.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ArmResult, RoundResult } from "../src/experiment/analyze.ts";
import type { Layers, Manifest } from "../src/manifest.ts";
import { loadPlaybook, mergeIntoPlaybook, playbookPrompt, scoreLearnings, validateClaims } from "../src/memory.ts";

const BASE: Layers = { background: "moonlit_temple", character: "Rex", action: "draws_blade", hook: "Your party is waiting.", cta: "Play Free", audio: "low_drums" };

/** An arm with a given ipm and a relative SE (installs ~ 1/seRel²). */
function arm(id: string, layers: Layers, ipm: number, seRel = 0.06): ArmResult {
	const se = ipm * seRel;
	const seg = { users: 1, impressions: 1, installs: 1, ipm, ipm_ci: [ipm - 1.96 * se, ipm + 1.96 * se] as [number, number] };
	return { variant_id: id, parent_id: null, is_control: false, layers, changed: [], users: 1, impressions: 1, clicks: 0, installs: 1, ctr: 0, ctr_se: 0, ipm, ipm_ci: [ipm - 1.96 * se, ipm + 1.96 * se],
		lift_vs_control: null, lift_ci: null, p_value: null, p_adj: null, ctr_lift_vs_control: null, guardrail_ok: true, p_best: 0, by_segment: { rpg: seg, companion: seg, casual: seg } };
}
const round = (n: number, arms: ArmResult[]): RoundResult => ({ round: n, control: arms[0]!.variant_id, arms, winner: arms[0]!.variant_id, winner_significant: false, decision: "", segment_winners: { rpg: "", companion: "", casual: "" }, looks_used: 4, stopped_early: false, total_users: 0, total_impressions: 0 });
const manifestsOf = (rs: RoundResult[]) => new Map(rs.flatMap((r) => r.arms.map((a) => [a.variant_id, { variant_id: a.variant_id, layers: a.layers } as Manifest] as const)));

test("validateClaims: structured, one layer, catalog values only", () => {
	const ok = validateClaims([{ id: "L1", kind: "effect", layer: "background", value: "moonlit_temple", vs: "neon_city", relation: "better", context: { character: "Rex" } }], new Set());
	assert.deepEqual(ok.errors, []);
	assert.equal(ok.claims.length, 1);
	const bad = validateClaims([
		{ id: "A", text: "changing hook, action or character lowers ipm", status: "supported" },
		{ id: "B", kind: "effect", layer: "character", value: "Rex", vs: "Zed", relation: "better" },
		{ id: "C", kind: "effect", layer: "audio", value: "none", vs: "none", relation: "similar" },
		{ id: "D", kind: "effect", layer: "cta", value: "Play Free", vs: "Install Now", relation: "worse" },
		{ id: "E", kind: "effect", layer: "hook", value: "Your party is waiting.", vs: "Free gems every day", relation: "better", context: { hook: "Your party is waiting." } },
		{ id: "F", kind: "optimum", variant_id: "g9_v99" },
	], new Set());
	assert.equal(bad.errors.length, 6, bad.errors.join("\n"));
});

test("scoreLearnings: only clean same-round contrasts count, and the code sets the status", () => {
	const r0 = round(0, [
		arm("c", BASE, 10),
		arm("bg", { ...BASE, background: "throne_room" }, 7), // clean contrast for background
		arm("two", { ...BASE, character: "Luna", cta: "Join Luna" }, 6), // two layers changed: not a contrast for character
	]);
	const r1 = round(1, [arm("c", BASE, 10), arm("mira", { ...BASE, character: "Mira" }, 11)]);
	const rs = [r0, r1];
	const ls = scoreLearnings([
		{ id: "L1", kind: "effect", layer: "background", value: "moonlit_temple", vs: "throne_room", relation: "better" },
		{ id: "L2", kind: "effect", layer: "character", value: "Rex", vs: "Luna", relation: "better" },
		{ id: "L3", kind: "effect", layer: "background", value: "throne_room", vs: "moonlit_temple", relation: "better" },
		{ id: "L4", kind: "effect", layer: "character", value: "Rex", vs: "Mira", relation: "better" },
		{ id: "L5", kind: "optimum", variant_id: "c" },
		{ id: "L6", kind: "effect", layer: "background", value: "moonlit_temple", vs: "throne_room", relation: "better", context: { character: "Kael" } },
	], rs, manifestsOf(rs));
	assert.deepEqual(ls.map((l) => l.status), ["supported", "unverified", "refuted", "open", "open", "unverified"]);
	assert.ok(Math.abs(ls[0]!.effect! - 10 / 7 + 1) < 1e-9);
	assert.equal(ls[4]!.coverage!.compared, 2);
	assert.deepEqual(ls[4]!.coverage!.higher.map((h) => h.variant_id), ["mira"]);
});

test("similar claims need the CI inside ±10%", () => {
	const r = round(0, [arm("c", BASE, 10, 0.01), arm("n", { ...BASE, audio: "none" }, 10.2, 0.01), arm("s", { ...BASE, audio: "upbeat_synth" }, 10.3, 0.2)]);
	const ls = scoreLearnings([
		{ id: "a", kind: "effect", layer: "audio", value: "low_drums", vs: "none", relation: "similar" },
		{ id: "b", kind: "effect", layer: "audio", value: "low_drums", vs: "upbeat_synth", relation: "similar" },
	], [r], manifestsOf([r]));
	assert.deepEqual(ls.map((l) => l.status), ["supported", "open"]);
});

test("memory: pools across runs, ranks by the conservative lift, archives what the data stops supporting", () => {
	const dir = mkdtempSync(join(tmpdir(), "mem-"));
	const claim = (id: string, layer: any, value: string, vs: string) => ({ id, kind: "effect", layer, value, vs, relation: "better" });
	// run 1: a big background effect, a smaller cta effect, an unresolved character comparison
	const r1 = round(0, [arm("c", BASE, 10), arm("bg", { ...BASE, background: "throne_room" }, 6), arm("cta", { ...BASE, cta: "Install Now" }, 8.4), arm("ch", { ...BASE, character: "Mira" }, 10.3)]);
	const l1 = scoreLearnings([claim("A", "background", "moonlit_temple", "throne_room"), claim("B", "cta", "Play Free", "Install Now"), claim("C", "character", "Rex", "Mira")], [r1], manifestsOf([r1]));
	const m1 = mergeIntoPlaybook("run1", "rk", l1, dir);
	assert.equal(m1.pb.entries.length, 3);
	assert.equal(m1.pb.entries[0]!.layer, "background");
	assert.equal(m1.pb.entries[1]!.layer, "cta");
	assert.equal(m1.pb.entries[2]!.statement.relation, "open");
	const prompt = playbookPrompt("rk", 8, dir);
	assert.match(prompt, /1\. background: moonlit_temple > throne_room/);
	assert.doesNotMatch(prompt, /character/); // open entries stay out of the prompt
	// run 2: strong evidence that the cta effect is the other way round → the old statement is archived
	const r2 = round(0, [arm("c", BASE, 10, 0.02), arm("cta", { ...BASE, cta: "Install Now" }, 13, 0.02)]);
	const l2 = scoreLearnings([claim("B", "cta", "Play Free", "Install Now")], [r2], manifestsOf([r2]));
	const m2 = mergeIntoPlaybook("run2", "rk", l2, dir);
	const cta = m2.pb.entries.find((e) => e.layer === "cta")!;
	assert.equal(cta.statement.winner, "Install Now");
	assert.equal(m2.archived, 1);
	// merging the same run again is a no-op for the evidence
	const again = mergeIntoPlaybook("run2", "rk", l2, dir);
	assert.equal(again.pb.entries.find((e) => e.layer === "cta")!.evidence.length, 2);
	// two more runs without character evidence → the open character entry expires (3 runs stale)
	mergeIntoPlaybook("run3", "rk", [], dir);
	const m4 = mergeIntoPlaybook("run4", "rk", [], dir);
	assert.equal(m4.pb.entries.some((e) => e.layer === "character"), false);
	const reasons = readFileSync(join(dir, "archive.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x).reason);
	assert.ok(reasons.some((r: string) => r.startsWith("refuted")));
	assert.ok(reasons.some((r: string) => r.startsWith("expired")));
});

test("memory: a legacy free-text playbook is never shown and is archived on the next write", async () => {
	const dir = mkdtempSync(join(tmpdir(), "mem-"));
	const { writeJson } = await import("../src/util/core.ts");
	writeJson(join(dir, "playbook.json"), { campaigns: [{ run_id: "old", learnings: [{ id: "L1", text: "Rex is a local optimum", status: "supported" }] }] });
	assert.equal(playbookPrompt("rk", 8, dir), "");
	assert.equal(loadPlaybook(dir).legacy?.campaigns?.length, 1);
	const m = mergeIntoPlaybook("new", "rk", [], dir);
	assert.equal(m.archived, 1);
	assert.equal(loadPlaybook(dir).pb.version, 2);
});

test("optimum: within-tolerance neighbours do not block support; >5% higher keeps it open", async () => {
	const { LAYER_NAMES, layerValues } = await import("../src/manifest.ts");
	const neighbours = (bump: (l: string, v: string) => number) => LAYER_NAMES.flatMap((l) => layerValues(l).filter((v) => v !== BASE[l]).map((v) => arm(`${l}:${v}`, { ...BASE, [l]: v }, 10 * bump(l, v))));
	const mk = (bump: (l: string, v: string) => number) => {
		const rs = [round(0, [arm("c", BASE, 10), ...neighbours(bump)])];
		return scoreLearnings([{ id: "o", kind: "optimum", variant_id: "c" }], rs, manifestsOf(rs))[0]!;
	};
	assert.equal(mk((l, v) => (l === "hook" && v === "The ruins are calling" ? 1.02 : 0.9)).status, "supported");
	assert.equal(mk((l, v) => (l === "audio" && v === "none" ? 1.08 : 0.9)).status, "open");
	assert.equal(mk((l, v) => (l === "audio" && v === "none" ? 1.5 : 0.9)).status, "refuted");
});

test("unclaimedContrasts: lists significant clean contrasts the agent did not claim", async () => {
	const { unclaimedContrasts } = await import("../src/memory.ts");
	const rs = [round(0, [arm("c", BASE, 10), arm("m", { ...BASE, character: "Mira" }, 13), arm("a", { ...BASE, audio: "none" }, 10.2), arm("t", { ...BASE, background: "throne_room" }, 7)])];
	const all = unclaimedContrasts(rs, []);
	assert.deepEqual(all.map((c) => `${c.layer}:${c.winner}>${c.loser}`), ["background:moonlit_temple>throne_room", "character:Mira>Rex"]);
	const rest = unclaimedContrasts(rs, [{ id: "x", kind: "effect", layer: "background", value: "throne_room", vs: "moonlit_temple", relation: "better" }]);
	assert.deepEqual(rest.map((c) => c.layer), ["character"]);
});

test("checkConvergence: needs the champion held as control and a supported local optimum", async () => {
	const { checkConvergence } = await import("../src/memory.ts");
	const { LAYER_NAMES, layerValues } = await import("../src/manifest.ts");
	const nb = LAYER_NAMES.flatMap((l) => layerValues(l).filter((v) => v !== BASE[l]).map((v) => arm(`${l}:${v}`, { ...BASE, [l]: v }, 9)));
	const held = (n: number, arms: ArmResult[]) => ({ ...round(n, [arm("c", BASE, 10), ...arms]), control: "c", winner: "c" });
	const r1 = held(1, nb.slice(0, 7)), r2 = held(2, nb.slice(7, 14)), r3 = held(3, nb.slice(14));
	const all = [round(0, [arm("c", BASE, 10)]), r1, r2, r3];
	assert.equal(checkConvergence(all.slice(0, 3), manifestsOf(all), { min_rounds: 3, hold_rounds: 2 }).converged, false); // too early
	assert.equal(checkConvergence(all, manifestsOf(all), { min_rounds: 3, hold_rounds: 2 }).converged, true);
	const moved = [...all.slice(0, 3), { ...r3, winner: "audio:none" }];
	assert.equal(checkConvergence(moved, manifestsOf(moved), { min_rounds: 3, hold_rounds: 2 }).converged, false);
});

test("validator: from round 1 the learnings list is required", async () => {
	const { validateProposal } = await import("../src/agent/validator.ts");
	const { loadConfig } = await import("../src/config.ts");
	const { makeManifest } = await import("../src/manifest.ts");
	const parent = makeManifest({ variant_id: "g0_v01", generation: 0, parent_id: null, round: 0, layers: BASE, format: { aspect: "9:16", duration_s: 6 } as Manifest["format"] });
	const results = [{ round: 0, control: "g0_v01", winner: "g0_v01", arms: [{ variant_id: "g0_v01", ipm: 5, ctr: 0.05 }] }] as any;
	const v = validateProposal({ round: 1, summary: "Testing one-layer changes on the champion.", control_variant_id: "g0_v01", variants: [] }, { round: 1, cfg: loadConfig(), manifests: new Map([["g0_v01", parent]]), results, champion: "g0_v01" });
	assert.match(v.errors.join("\n"), /learnings: give your running list/);
});
