// Simulated audience: the two-stage logistic model fit by py/audience/fit.py.
// It is the "world" for experiments. The agent never reads it; it only sees experiment results.
import { PATHS } from "./config.ts";
import { LAYER_NAMES, type Layers, type Manifest } from "./manifest.ts";
import { readJson } from "./util/core.ts";

export type Segment = "rpg" | "companion" | "casual";
export const SEGMENTS: Segment[] = ["rpg", "companion", "casual"];

type ModelJson = {
	layers: Record<string, string[]>;
	expo_cap: number;
	click: { weights: Record<string, number> };
	install_given_click: { weights: Record<string, number> };
	install_given_no_click: Record<Segment, number>;
	segment_mix: Record<Segment, number>;
	os_mix: Record<Segment, Record<string, number>>;
	impressions_per_user: Record<Segment, Record<string, number>>;
	diagnostics: Record<string, unknown>;
	data_sha256: string;
};

export type ExpectedRates = { ctr: number; ipm: number; installs_per_user: number; impressions_per_user: number };

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export class AudienceModel {
	readonly json: ModelJson;
	constructor(path = PATHS.audienceModel) {
		this.json = readJson<ModelJson>(path);
	}
	get segmentMix() {
		return this.json.segment_mix;
	}
	get osMix() {
		return this.json.os_mix;
	}
	get impressionsPerUser() {
		return this.json.impressions_per_user;
	}

	private eta(w: Record<string, number>, layers: Layers, format: Manifest["format"], seg: Segment, os: string): number {
		let e = w["(intercept)"] ?? 0;
		for (const l of LAYER_NAMES) {
			e += w[`${l}=${layers[l]}`] ?? 0;
			e += w[`segment=${seg}|${l}=${layers[l]}`] ?? 0;
		}
		e += (w[`aspect=${format.aspect}`] ?? 0) + (w[`duration=${format.duration_s}`] ?? 0) + (w[`os=${os}`] ?? 0) + (w[`segment=${seg}`] ?? 0);
		return e;
	}

	/** Per-impression probabilities for one user context. exposure = how many times this user has now seen it (1-based). */
	probs(layers: Layers, format: Manifest["format"], seg: Segment, os: string, exposure: number): { click: number; installIfClick: number; installIfNoClick: number } {
		const wc = this.json.click.weights;
		const ex = Math.log(Math.min(exposure, this.json.expo_cap));
		const click = sigmoid(this.eta(wc, layers, format, seg, os) + (wc["expo"] ?? 0) * ex + (wc[`segment=${seg}|expo`] ?? 0) * ex);
		const installIfClick = sigmoid(this.eta(this.json.install_given_click.weights, layers, format, seg, os));
		return { click, installIfClick, installIfNoClick: this.json.install_given_no_click[seg] };
	}

	/** Expected per-user outcomes under the simulator's process (k impressions, stop after an install). */
	expectedForSegment(layers: Layers, format: Manifest["format"], seg: Segment): ExpectedRates {
		let imps = 0, clicks = 0, installs = 0;
		for (const [os, pOs] of Object.entries(this.json.os_mix[seg])) {
			const dist = this.json.impressions_per_user[seg];
			// survival through impressions: S_j = P(no install before impression j)
			const maxK = Math.max(...Object.keys(dist).map(Number));
			const per: { c: number; i: number }[] = [];
			for (let j = 1; j <= maxK; j++) {
				const p = this.probs(layers, format, seg, os, j);
				per.push({ c: p.click, i: p.click * p.installIfClick + (1 - p.click) * p.installIfNoClick });
			}
			for (const [kStr, pk] of Object.entries(dist)) {
				const k = Number(kStr);
				let S = 1, ei = 0, ec = 0;
				for (let j = 0; j < k; j++) {
					ei += S;
					ec += S * per[j]!.c;
					S *= 1 - per[j]!.i;
				}
				imps += pOs * pk * ei;
				clicks += pOs * pk * ec;
				installs += pOs * pk * (1 - S);
			}
		}
		return { ctr: clicks / imps, ipm: (1000 * installs) / imps, installs_per_user: installs, impressions_per_user: imps };
	}

	/** Traffic-weighted expectation across segments. */
	expected(layers: Layers, format: Manifest["format"]): ExpectedRates & { by_segment: Record<Segment, ExpectedRates> } {
		const by = {} as Record<Segment, ExpectedRates>;
		let imps = 0, clicks = 0, installs = 0;
		for (const s of SEGMENTS) {
			const r = this.expectedForSegment(layers, format, s);
			by[s] = r;
			const w = this.json.segment_mix[s];
			imps += w * r.impressions_per_user;
			clicks += w * r.ctr * r.impressions_per_user;
			installs += w * r.installs_per_user;
		}
		return { ctr: clicks / imps, ipm: (1000 * installs) / imps, installs_per_user: installs, impressions_per_user: imps, by_segment: by };
	}

	/** Brute-force the whole catalog (6*4*5*5*4*4 = 9600 creatives). Used only for offline evaluation. */
	optimum(format: Manifest["format"], top = 10): { layers: Layers; ipm: number }[] {
		const L = this.json.layers;
		const out: { layers: Layers; ipm: number }[] = [];
		for (const background of L.background!) for (const character of L.character!) for (const action of L.action!)
			for (const hook of L.hook!) for (const cta of L.cta!) for (const audio of L.audio!) {
				const layers = { background, character, action, hook, cta, audio };
				out.push({ layers, ipm: this.expected(layers, format).ipm });
			}
		out.sort((a, b) => b.ipm - a.ipm);
		return out.slice(0, top).concat([{ layers: out[out.length - 1]!.layers, ipm: out[out.length - 1]!.ipm }]);
	}
}
