// Unit tests for the deterministic parts: statistics, manifests, validator, audience model, simulator, assignment.
// Run: npm test   (node --test, TypeScript runs natively on Node >= 22.19)
import assert from "node:assert/strict";
import { test } from "node:test";
import { AudienceModel } from "../src/audience.ts";
import { loadConfig } from "../src/config.ts";
import { validateProposal } from "../src/agent/validator.ts";
import { LocalPlatform } from "../src/experiment/platform.ts";
import { simulateBatch } from "../src/experiment/simulate.ts";
import { creativeKey, diffLayers, makeManifest, type Layers, type Manifest } from "../src/manifest.ts";
import { achievableMde, addUser, compareRatio, emptySums, holm, normInv, probBest, ratio, usersPerArm } from "../src/stats.ts";

const FORMAT = { aspect: "9:16", duration_s: 6 } as Manifest["format"];
const A: Layers = { background: "moonlit_temple", character: "Luna", action: "draws_blade", hook: "She remembers everything.", cta: "Play Free", audio: "none" };
const B: Layers = { ...A, hook: "Your party is waiting." };

test("normInv and power analysis", () => {
	assert.ok(Math.abs(normInv(0.975) - 1.95996) < 1e-3);
	const n = usersPerArm(0.01, 0.3, 0.05, 0.8, 1);
	assert.ok(n > 15000 && n < 22000, `n=${n}`);
	assert.ok(Math.abs(achievableMde(0.01, n, 0.05, 0.8, 1) - 0.3) < 0.01);
});

test("holm adjusts monotonically and caps at 1", () => {
	const adj = holm([0.01, 0.04, 0.03, 0.5]);
	assert.deepEqual(adj.map((x) => Number(x.toFixed(2))), [0.04, 0.09, 0.09, 0.5]);
});

test("delta-method ratio: clustered users widen the SE vs a naive binomial", () => {
	const s = emptySums();
	for (let i = 0; i < 5000; i++) addUser(s, i % 2 ? 1 : 3, i % 50 === 0 ? 1 : 0);
	const r = ratio(s);
	const naive = Math.sqrt((r.r * (1 - r.r)) / s.x);
	assert.ok(r.se > naive * 0.9, `delta ${r.se} vs naive ${naive}`);
	const c = compareRatio(s, s);
	assert.equal(c.diff, 0);
	assert.ok(c.p > 0.99);
});

test("probBest favors the clearly better arm and is seeded", () => {
	const p1 = probBest([{ installs: 10, impressions: 5000 }, { installs: 40, impressions: 5000 }], "s");
	const p2 = probBest([{ installs: 10, impressions: 5000 }, { installs: 40, impressions: 5000 }], "s");
	assert.deepEqual(p1, p2);
	assert.ok(p1[1]! > 0.99);
});

test("manifest diff and creative key", () => {
	assert.deepEqual(diffLayers(A, B), [{ layer: "hook", from: "She remembers everything.", to: "Your party is waiting." }]);
	assert.equal(creativeKey(A, FORMAT), creativeKey({ ...A }, FORMAT));
	assert.notEqual(creativeKey(A, FORMAT), creativeKey(B, FORMAT));
});

test("validator: catalog, attributable edits, no re-tests, real citations", () => {
	const cfg = loadConfig();
	const parent = makeManifest({ variant_id: "g0_v01", generation: 0, parent_id: null, round: 0, layers: A, format: FORMAT });
	const manifests = new Map([[parent.variant_id, parent]]);
	const results = [{ round: 0, control: "g0_v01", winner: "g0_v01", arms: [{ variant_id: "g0_v01", ipm: 5.0, ctr: 0.05 }] }] as any;
	const base = { round: 1, summary: "Testing hooks and CTAs on the champion after round 0.", control_variant_id: "g0_v01",
		learnings: [{ id: "L1", kind: "effect", layer: "cta", value: "Play Free", vs: "Install Now", relation: "better" }] };
	const seven = (changes: Partial<Layers>[]) => changes.map((c) => ({ parent_id: "g0_v01", changes: c, rationale: "x" }));
	const okChanges: Partial<Layers>[] = [{ hook: "Your party is waiting." }, { hook: "The ruins are calling" }, { cta: "Install Now" }, { audio: "low_drums" }, { background: "neon_city" }, { character: "Mira" }, { action: "casts_spell", cta: "Claim Bonus" }];
	const ok = validateProposal({ ...base, variants: seven(okChanges), evidence: [{ variant_id: "g0_v01", round: 0, metric: "ipm", value: 5.0 }] }, { round: 1, cfg, manifests, results, champion: "g0_v01" });
	assert.ok(ok.ok, ok.errors.join("; "));
	assert.equal(ok.manifests.length, 7);
	assert.equal(ok.manifests[0]!.parent_id, "g0_v01");

	const bad = validateProposal({ ...base, variants: seven([{ hook: "Free lunch" } as any, { background: "neon_city", character: "Mira", action: "casts_spell" }, { cta: "Install Now" }, { cta: "Install Now" }, {}, { audio: "low_drums" }, { character: "Rex" }]),
		evidence: [{ variant_id: "g0_v01", round: 0, metric: "ipm", value: 9.9 }] }, { round: 1, cfg, manifests, results, champion: "g0_v01" });
	const text = bad.errors.join("\n");
	assert.match(text, /not in the catalog/);
	assert.match(text, /changes 3 layers/);
	assert.match(text, /duplicates another variant/);
	assert.match(text, /changes nothing vs parent/);
	assert.match(text, /cited 9\.9 but recorded 5\.000/);
});

test("audience model: expectation matches simulation (local platform, 40k users)", async () => {
	const model = new AudienceModel();
	const m = makeManifest({ variant_id: "x", generation: 0, parent_id: null, round: 0, layers: A, format: FORMAT });
	const exp = await new LocalPlatform().createOrGet({ name: "t", round: 0, hypothesis: "", description: "", arms: [{ group: "x", variant_id: "x", creative_key: m.creative_key, is_control: true }] });
	const agg = await simulateBatch({ model, manifests: new Map([["x", m]]), platform: new LocalPlatform(), exp, batch: 1, userStart: 0, userCount: 40000, seed: "test", eventMode: "per_user" });
	const a = agg.arms.x!;
	const e = model.expected(A, FORMAT);
	const r = ratio(a.install);
	assert.ok(Math.abs(1000 * r.r - e.ipm) < 4 * 1000 * r.se, `sim ${1000 * r.r} vs expected ${e.ipm} (se ${1000 * r.se})`);
	assert.ok(Math.abs(a.impressions / a.users - e.impressions_per_user) < 0.05);
});

test("local assignment is balanced and deterministic", async () => {
	const p = new LocalPlatform();
	const exp = await p.createOrGet({ name: "bal", round: 0, hypothesis: "", description: "", arms: Array.from({ length: 8 }, (_, i) => ({ group: `g${i}`, variant_id: `v${i}`, creative_key: "", is_control: i === 0 })) });
	const counts = new Map<string, number>();
	for (let i = 0; i < 16000; i++) {
		const v = p.assign(exp, { userID: `u${i}`, segment: "rpg", os: "ios" });
		counts.set(v, (counts.get(v) ?? 0) + 1);
	}
	for (const c of counts.values()) assert.ok(Math.abs(c - 2000) < 200, `arm size ${c}`);
	assert.equal(p.assign(exp, { userID: "u1", segment: "rpg", os: "ios" }), p.assign(exp, { userID: "u1", segment: "casual", os: "android" }));
});

test("analyze: a non-significant challenger replaces the control only with P(best) >= promoteMinPbest", async () => {
	const { analyze } = await import("../src/experiment/analyze.ts");
	const { emptyArm } = await import("../src/experiment/simulate.ts");
	const agg = (id: string, users: number, installs: number) => {
		const a = emptyArm(id);
		for (let i = 0; i < users; i++) {
			const inst = i < installs ? 1 : 0;
			for (const c of [a, a.seg.rpg]) { c.users++; c.impressions++; c.installs += inst; addUser(c.install, 1, inst); addUser(c.click, 1, inst); }
		}
		return a;
	};
	const ms = (ids: string[]) => new Map(ids.map((id, i) => [id, makeManifest({ variant_id: id, generation: 0, parent_id: null, round: 0, layers: { ...A, audio: ["none", "low_drums", "upbeat_synth"][i]! }, format: FORMAT })]));
	const run = (arms: Record<string, ReturnType<typeof agg>>) => analyze({ round: 1, arms, manifests: ms(Object.keys(arms)), control: "c", alpha: 0.05, guardrailDrop: 1, seed: "t", looksUsed: 4, stoppedEarly: false, promoteMinPbest: 0.8 });
	const weak = run({ c: agg("c", 20000, 200), x: agg("x", 20000, 215), y: agg("y", 20000, 210) });
	assert.equal(weak.winner, "c");
	assert.equal(weak.top_arm === "x" || weak.top_arm === "y", true);
	assert.match(weak.decision, /^keep control: best challenger/);
	const directional = run({ c: agg("c", 20000, 200), x: agg("x", 20000, 230) });
	assert.equal(directional.winner, "x");
	assert.match(directional.decision, /^promote x/);
	const strong = run({ c: agg("c", 20000, 200), x: agg("x", 20000, 300), y: agg("y", 20000, 205) });
	assert.equal(strong.winner, "x");
	assert.match(strong.decision, /^ship x/);
});
