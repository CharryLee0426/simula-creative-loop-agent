// Statistics for experiment readout. Deterministic code, no model calls.
import { Rng } from "./util/core.ts";

export function normCdf(z: number): number {
	// Abramowitz-Stegun 7.1.26 via erf
	const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
	const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-(z * z) / 2);
	return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Inverse normal CDF (Acklam). */
export function normInv(p: number): number {
	const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
	const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
	const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
	const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
	const pl = 0.02425;
	if (p < pl) {
		const q = Math.sqrt(-2 * Math.log(p));
		return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
	}
	if (p > 1 - pl) return -normInv(1 - p);
	const q = p - 0.5;
	const r = q * q;
	return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export function wilson(k: number, n: number, z = 1.96): [number, number] {
	if (n === 0) return [0, 0];
	const p = k / n;
	const d = 1 + (z * z) / n;
	const c = p + (z * z) / (2 * n);
	const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

/** Per-user sums for a ratio metric (y / x summed over users, e.g. installs / impressions). */
export type RatioSums = { n: number; x: number; y: number; xx: number; yy: number; xy: number };
export const emptySums = (): RatioSums => ({ n: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 });
export function addUser(s: RatioSums, x: number, y: number): void {
	s.n++; s.x += x; s.y += y; s.xx += x * x; s.yy += y * y; s.xy += x * y;
}
export function mergeSums(a: RatioSums, b: RatioSums): RatioSums {
	return { n: a.n + b.n, x: a.x + b.x, y: a.y + b.y, xx: a.xx + b.xx, yy: a.yy + b.yy, xy: a.xy + b.xy };
}

/** Ratio estimate with delta-method variance (users are the randomization unit, impressions are clustered in users). */
export function ratio(s: RatioSums): { r: number; se: number } {
	if (s.n < 2 || s.x === 0) return { r: 0, se: 0 };
	const n = s.n;
	const mx = s.x / n, my = s.y / n;
	const r = s.y / s.x;
	const vxx = (s.xx - n * mx * mx) / (n - 1);
	const vyy = (s.yy - n * my * my) / (n - 1);
	const vxy = (s.xy - n * mx * my) / (n - 1);
	const v = (vyy - 2 * r * vxy + r * r * vxx) / (n * mx * mx);
	return { r, se: Math.sqrt(Math.max(v, 0)) };
}

export type Comparison = { diff: number; lift: number; lift_ci: [number, number]; z: number; p: number };
export function compareRatio(control: RatioSums, test: RatioSums): Comparison {
	const c = ratio(control), t = ratio(test);
	const se = Math.sqrt(c.se ** 2 + t.se ** 2);
	const diff = t.r - c.r;
	const z = se > 0 ? diff / se : 0;
	const p = 2 * (1 - normCdf(Math.abs(z)));
	const lift = c.r > 0 ? diff / c.r : 0;
	const liftSe = c.r > 0 ? Math.sqrt(t.se ** 2 / c.r ** 2 + (t.r ** 2 * c.se ** 2) / c.r ** 4) : 0;
	return { diff, lift, lift_ci: [lift - 1.96 * liftSe, lift + 1.96 * liftSe], z, p };
}

/** Holm-Bonferroni adjusted p-values (same order as input). */
export function holm(ps: number[]): number[] {
	const m = ps.length;
	const order = ps.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
	const adj = new Array<number>(m);
	let run = 0;
	order.forEach(([p, i], rank) => {
		run = Math.max(run, Math.min(1, (m - rank) * p));
		adj[i] = run;
	});
	return adj;
}

/** P(arm has the highest install rate) from Beta(1+installs, 1+impressions-installs) posteriors (Monte Carlo, seeded). */
export function probBest(arms: { installs: number; impressions: number }[], seed: string, draws = 20000): number[] {
	const rng = new Rng(seed);
	const wins = new Array(arms.length).fill(0);
	for (let d = 0; d < draws; d++) {
		let best = -1, bi = 0;
		arms.forEach((a, i) => {
			const v = rng.beta(1 + a.installs, 1 + Math.max(0, a.impressions - a.installs));
			if (v > best) { best = v; bi = i; }
		});
		wins[bi]++;
	}
	return wins.map((w) => w / draws);
}

/** Users per arm to detect a relative lift `mde` on a per-user conversion rate p (two-sided, Bonferroni over m comparisons). */
export function usersPerArm(p: number, mde: number, alpha: number, power: number, comparisons: number): number {
	const p2 = p * (1 + mde);
	const za = normInv(1 - alpha / (2 * Math.max(1, comparisons)));
	const zb = normInv(power);
	return Math.ceil(((za + zb) ** 2 * (p * (1 - p) + p2 * (1 - p2))) / (p2 - p) ** 2);
}
/** Inverse: relative MDE achievable with n users per arm. */
export function achievableMde(p: number, n: number, alpha: number, power: number, comparisons: number): number {
	let lo = 0.001, hi = 20;
	for (let i = 0; i < 60; i++) {
		const mid = (lo + hi) / 2;
		if (usersPerArm(p, mid, alpha, power, comparisons) > n) lo = mid; else hi = mid;
	}
	return hi;
}

/** O'Brien-Fleming-shaped efficacy boundary for look k of K (z_{alpha/2} * sqrt(K/k)). */
export function obfBoundary(alpha: number, looks: number, k: number): number {
	return normInv(1 - alpha / 2) * Math.sqrt(looks / k);
}
