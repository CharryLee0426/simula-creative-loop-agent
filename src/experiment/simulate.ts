// Traffic simulation: synthetic users arrive, the platform assigns each to an arm, the audience model samples what
// they do on each impression (fatigue included, no more ads after an install), and the outcomes go back to the
// platform as events. Fully deterministic given (seed, run, round, user index) and the platform's assignment.
import { AudienceModel, SEGMENTS, type Segment } from "../audience.ts";
import type { Manifest } from "../manifest.ts";
import { addUser, emptySums, mergeSums, type RatioSums } from "../stats.ts";
import { Rng } from "../util/core.ts";
import type { CreatedExperiment, Platform, SimUser } from "./platform.ts";

export type Counts = { users: number; impressions: number; clicks: number; installs: number; install: RatioSums; click: RatioSums };
export type ArmAgg = Counts & { variant_id: string; seg: Record<Segment, Counts> };
export type BatchAgg = { batch: number; users: number; events: number; unassigned: number; arms: Record<string, ArmAgg> };

const emptyCounts = (): Counts => ({ users: 0, impressions: 0, clicks: 0, installs: 0, install: emptySums(), click: emptySums() });
function addCounts(c: Counts, imps: number, clicks: number, inst: number): void {
	c.users++; c.impressions += imps; c.clicks += clicks; c.installs += inst;
	addUser(c.install, imps, inst);
	addUser(c.click, imps, clicks);
}
function mergeCounts(a: Counts, b: Counts): Counts {
	return { users: a.users + b.users, impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, installs: a.installs + b.installs,
		install: mergeSums(a.install, b.install), click: mergeSums(a.click, b.click) };
}
export function emptyArm(variant_id: string): ArmAgg {
	return { variant_id, ...emptyCounts(), seg: { rpg: emptyCounts(), companion: emptyCounts(), casual: emptyCounts() } };
}
export function mergeArms(a: ArmAgg, b: ArmAgg): ArmAgg {
	const seg = {} as Record<Segment, Counts>;
	for (const s of SEGMENTS) seg[s] = mergeCounts(a.seg[s], b.seg[s]);
	return { variant_id: a.variant_id, ...mergeCounts(a, b), seg };
}
export function mergeBatches(batches: BatchAgg[], variantIds: string[]): Record<string, ArmAgg> {
	const out: Record<string, ArmAgg> = Object.fromEntries(variantIds.map((v) => [v, emptyArm(v)]));
	for (const b of batches) for (const [v, a] of Object.entries(b.arms)) out[v] = mergeArms(out[v] ?? emptyArm(v), a);
	return out;
}

export function simUser(model: AudienceModel, seed: string, index: number): { user: SimUser; k: number; rng: Rng } {
	const rng = new Rng(`${seed}|u${index}`);
	const segment = rng.categorical(model.segmentMix as Record<Segment, number>);
	const os = rng.categorical(model.osMix[segment] as Record<string, number>);
	const k = Number(rng.categorical(model.impressionsPerUser[segment] as Record<string, number>));
	return { user: { userID: `${seed.replace(/[^a-zA-Z0-9]/g, "")}-u${index}`, segment, os }, k, rng };
}

export async function simulateBatch(args: {
	model: AudienceModel;
	manifests: Map<string, Manifest>;
	platform: Platform;
	exp: CreatedExperiment;
	batch: number;
	userStart: number;
	userCount: number;
	seed: string;
	eventMode: "per_user" | "per_impression";
	onProgress?: (done: number) => void;
}): Promise<BatchAgg> {
	const { model, manifests, platform, exp } = args;
	const arms: Record<string, ArmAgg> = Object.fromEntries([...manifests.keys()].map((v) => [v, emptyArm(v)]));
	const memo = new Map<string, ReturnType<AudienceModel["probs"]>>();
	let events = 0, unassigned = 0;
	for (let i = args.userStart; i < args.userStart + args.userCount; i++) {
		const { user, k, rng } = simUser(model, args.seed, i);
		const vid = platform.assign(exp, user);
		const m = vid ? manifests.get(vid) : undefined;
		if (!vid || !m) { unassigned++; continue; }
		let imps = 0, clicks = 0, installed = false;
		for (let j = 1; j <= k; j++) {
			const key = `${vid}|${user.segment}|${user.os}|${j}`;
			let p = memo.get(key);
			if (!p) { p = model.probs(m.layers, m.format, user.segment as Segment, user.os, j); memo.set(key, p); }
			imps++;
			const clicked = rng.next() < p.click;
			if (clicked) clicks++;
			if (rng.next() < (clicked ? p.installIfClick : p.installIfNoClick)) { installed = true; break; }
		}
		events += platform.record(exp, user, vid, { impressions: imps, clicks, installed }, args.eventMode);
		addCounts(arms[vid]!, imps, clicks, installed ? 1 : 0);
		addCounts(arms[vid]!.seg[user.segment as Segment], imps, clicks, installed ? 1 : 0);
		const done = i - args.userStart + 1;
		if (done % 2000 === 0) {
			await platform.flush();
			args.onProgress?.(done);
		}
	}
	await platform.flush();
	return { batch: args.batch, users: args.userCount, events, unassigned, arms };
}
