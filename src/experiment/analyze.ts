// Readout of one round: per-arm rates with CIs, challenger vs control tests (Holm-adjusted), P(best), CTR guardrail,
// per-segment breakdown, early-stopping decision and the champion for the next round.
import { SEGMENTS, type Segment } from "../audience.ts";
import { diffLayers, type Manifest } from "../manifest.ts";
import { compareRatio, holm, obfBoundary, probBest, ratio } from "../stats.ts";
import type { ArmAgg } from "./simulate.ts";

export type ArmResult = {
	variant_id: string;
	parent_id: string | null;
	is_control: boolean;
	layers: Manifest["layers"];
	changed: string[];
	users: number;
	impressions: number;
	clicks: number;
	installs: number;
	ctr: number;
	ctr_se: number;
	ipm: number;
	ipm_ci: [number, number];
	lift_vs_control: number | null;
	lift_ci: [number, number] | null;
	p_value: number | null;
	p_adj: number | null;
	ctr_lift_vs_control: number | null;
	guardrail_ok: boolean;
	p_best: number;
	by_segment: Record<Segment, { users: number; impressions: number; installs: number; ipm: number; ipm_ci: [number, number] }>;
};

export type RoundResult = {
	round: number;
	control: string;
	arms: ArmResult[];
	winner: string;
	winner_significant: boolean;
	decision: string;
	segment_winners: Record<Segment, string>;
	looks_used: number;
	stopped_early: boolean;
	total_users: number;
	total_impressions: number;
};

export function analyze(args: {
	round: number;
	arms: Record<string, ArmAgg>;
	manifests: Map<string, Manifest>;
	/** Every known manifest, to resolve parents that are not arms of this experiment. */
	parents?: Map<string, Manifest>;
	control: string;
	alpha: number;
	guardrailDrop: number;
	seed: string;
	looksUsed: number;
	stoppedEarly: boolean;
}): RoundResult {
	const ids = [...args.manifests.keys()];
	const ctrl = args.arms[args.control]!;
	const pb = probBest(ids.map((v) => ({ installs: args.arms[v]!.installs, impressions: args.arms[v]!.impressions })), `${args.seed}|pbest`);
	const comps = ids.map((v) => (v === args.control ? null : compareRatio(ctrl.install, args.arms[v]!.install)));
	const ctrComps = ids.map((v) => (v === args.control ? null : compareRatio(ctrl.click, args.arms[v]!.click)));
	const rawP = comps.filter((c) => c !== null).map((c) => c!.p);
	const adj = holm(rawP);
	let ai = 0;
	const arms: ArmResult[] = ids.map((v, i) => {
		const a = args.arms[v]!;
		const m = args.manifests.get(v)!;
		const inst = ratio(a.install);
		const clk = ratio(a.click);
		const c = comps[i];
		const cc = ctrComps[i];
		const pAdj = c ? adj[ai++]! : null;
		const guardrailBad = cc ? cc.lift < -args.guardrailDrop && cc.p < 0.05 : false;
		const parent = m.parent_id ? (args.manifests.get(m.parent_id) ?? args.parents?.get(m.parent_id)) : undefined;
		const bySeg = {} as ArmResult["by_segment"];
		for (const s of SEGMENTS) {
			const sr = ratio(a.seg[s].install);
			bySeg[s] = { users: a.seg[s].users, impressions: a.seg[s].impressions, installs: a.seg[s].installs, ipm: 1000 * sr.r,
				ipm_ci: [1000 * Math.max(0, sr.r - 1.96 * sr.se), 1000 * (sr.r + 1.96 * sr.se)] };
		}
		return {
			variant_id: v,
			parent_id: m.parent_id,
			is_control: v === args.control,
			layers: m.layers,
			changed: parent ? diffLayers(parent.layers, m.layers).map((d) => d.layer) : [],
			users: a.users, impressions: a.impressions, clicks: a.clicks, installs: a.installs,
			ctr: clk.r, ctr_se: clk.se,
			ipm: 1000 * inst.r,
			ipm_ci: [1000 * Math.max(0, inst.r - 1.96 * inst.se), 1000 * (inst.r + 1.96 * inst.se)],
			lift_vs_control: c ? c.lift : null,
			lift_ci: c ? c.lift_ci : null,
			p_value: c ? c.p : null,
			p_adj: pAdj,
			ctr_lift_vs_control: cc ? cc.lift : null,
			guardrail_ok: !guardrailBad,
			p_best: pb[i]!,
			by_segment: bySeg,
		};
	});
	const eligible = arms.filter((a) => a.guardrail_ok);
	const winner = [...eligible].sort((a, b) => b.p_best - a.p_best || b.ipm - a.ipm)[0]!;
	const sig = !winner.is_control && (winner.p_adj ?? 1) < args.alpha && (winner.lift_vs_control ?? 0) > 0;
	const decision = winner.is_control
		? "keep control: no challenger beat it"
		: sig
			? `ship ${winner.variant_id}: beats control by ${(100 * winner.lift_vs_control!).toFixed(0)}% (Holm p=${winner.p_adj!.toFixed(3)})`
			: `promote ${winner.variant_id} as champion (directional: P(best)=${winner.p_best.toFixed(2)}, not significant vs control)`;
	const segWin = {} as Record<Segment, string>;
	for (const s of SEGMENTS) segWin[s] = [...arms].sort((a, b) => b.by_segment[s].ipm - a.by_segment[s].ipm)[0]!.variant_id;
	return {
		round: args.round,
		control: args.control,
		arms,
		winner: winner.variant_id,
		winner_significant: sig,
		decision,
		segment_winners: segWin,
		looks_used: args.looksUsed,
		stopped_early: args.stoppedEarly,
		total_users: arms.reduce((s, a) => s + a.users, 0),
		total_impressions: arms.reduce((s, a) => s + a.impressions, 0),
	};
}

/** Early stop at look k when the leader beats control past an O'Brien-Fleming boundary (Bonferroni over challengers). */
export function shouldStopEarly(r: RoundResult, look: number, looks: number, alpha: number): { stop: boolean; why: string } {
	const challengers = r.arms.filter((a) => !a.is_control);
	const leader = [...challengers].sort((a, b) => b.ipm - a.ipm)[0];
	if (!leader || look >= looks) return { stop: false, why: "" };
	const ctrl = r.arms.find((a) => a.is_control)!;
	const se = Math.sqrt(((leader.ipm_ci[1] - leader.ipm_ci[0]) / 3.92) ** 2 + ((ctrl.ipm_ci[1] - ctrl.ipm_ci[0]) / 3.92) ** 2);
	const z = se > 0 ? (leader.ipm - ctrl.ipm) / se : 0;
	const bound = obfBoundary(alpha / challengers.length, looks, look);
	const stop = z > bound && leader.p_best >= 0.95;
	return { stop, why: `look ${look}/${looks}: leader ${leader.variant_id} z=${z.toFixed(2)} vs boundary ${bound.toFixed(2)}, P(best)=${leader.p_best.toFixed(2)}` };
}
