// Offline evaluation of the agent. Uses the audience model's expected rates as ground truth (the agent never sees
// them) to score the final creative, and compares against cheap baseline policies run on the same traffic budget:
//   random     — every round tests fresh random creatives against the champion
//   mutate-1   — the agent's gen-0 set, then 7 random one-layer mutations of the champion per round
//   history    — no experiments: best historical value per layer (marginals from the CSV)
import { join } from "node:path";
import { LAYER_NAMES, layerValues, type Layers, type Manifest } from "../manifest.ts";
import { allManifests, roundResults, type RunContext } from "../runtime.ts";
import { log, readJsonIf, Rng, writeJson } from "../util/core.ts";
import { PATHS } from "../config.ts";

type Format = Manifest["format"];

function poisson(rng: Rng, lambda: number): number {
	if (lambda > 40) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * rng.normal()));
	let k = 0, p = 1;
	const L = Math.exp(-lambda);
	do { k++; p *= rng.next(); } while (p > L);
	return k - 1;
}

/** One noisy readout of an arm: installs drawn around the true expectation for the given traffic. */
function readout(r: RunContext, layers: Layers, format: Format, users: number, rng: Rng, cache: Map<string, { ipu: number; imps: number; ipm: number }>) {
	const key = JSON.stringify(layers);
	let e = cache.get(key);
	if (!e) {
		const x = r.audience.expected(layers, format);
		e = { ipu: x.installs_per_user, imps: x.impressions_per_user, ipm: x.ipm };
		cache.set(key, e);
	}
	const installs = poisson(rng, e.ipu * users);
	const impressions = e.imps * users;
	return { observed: (1000 * (installs + 0.5)) / (impressions + 1), trueIpm: e.ipm };
}

function randomLayers(rng: Rng): Layers {
	return Object.fromEntries(LAYER_NAMES.map((l) => [l, rng.pick(layerValues(l))])) as Layers;
}

function runBaseline(r: RunContext, kind: "random" | "mutate", seedSet: Layers[], rounds: number, armsN: number, usersPerArm: number[], format: Format, seed: string, cache: Map<string, any>) {
	const rng = new Rng(seed);
	let arms = kind === "random" ? Array.from({ length: armsN }, () => randomLayers(rng)) : seedSet;
	let champion = arms[0]!;
	for (let n = 0; n <= rounds; n++) {
		const scored = arms.map((l) => ({ l, ...readout(r, l, format, usersPerArm[n] ?? usersPerArm[usersPerArm.length - 1]!, rng, cache) }));
		champion = scored.sort((a, b) => b.observed - a.observed)[0]!.l;
		if (kind === "random") arms = [champion, ...Array.from({ length: armsN - 1 }, () => randomLayers(rng))];
		else arms = [champion, ...Array.from({ length: armsN - 1 }, () => {
			const l = { ...champion };
			const layer = rng.pick(LAYER_NAMES);
			const opts = layerValues(layer).filter((v) => v !== champion[layer]);
			l[layer] = rng.pick(opts);
			return l;
		})];
	}
	return cache.get(JSON.stringify(champion))?.ipm ?? r.audience.expected(champion, format).ipm;
}

export async function runEval(r: RunContext, reps = 20): Promise<void> {
	const format: Format = { aspect: r.cfg.render.aspect, duration_s: r.cfg.render.duration_s } as Format;
	const results = roundResults(r.paths);
	if (!results.length) throw new Error("no round results to evaluate");
	const manifests = allManifests(r.paths);
	log.step("brute-forcing the catalog optimum under the audience model (9,600 creatives)");
	const opt = r.audience.optimum(format, 5);
	const best = opt[0]!;
	const worst = opt[opt.length - 1]!;
	const trueOf = (id: string) => r.audience.expected(manifests.get(id)!.layers, format).ipm;
	const agentTraj = results.map((x) => ({ round: x.round, champion: x.winner, true_ipm: trueOf(x.winner), observed_ipm: x.arms.find((a) => a.variant_id === x.winner)!.ipm }));
	const final = agentTraj[agentTraj.length - 1]!;
	const control = results[0]!.arms.find((a) => a.is_control)!.variant_id;
	const seedSet = results[0]!.arms.map((a) => manifests.get(a.variant_id)!.layers);
	const usersPerArm = results.map((x) => Math.round(x.total_users / x.arms.length));
	const rounds = results.length - 1;
	const cache = new Map<string, any>();
	const stats = (xs: number[]) => {
		const m = xs.reduce((a, b) => a + b, 0) / xs.length;
		return { mean: m, sd: Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)) };
	};
	log.step(`baselines: ${reps} replications each`);
	const rand = stats(Array.from({ length: reps }, (_, i) => runBaseline(r, "random", seedSet, rounds, results[0]!.arms.length, usersPerArm, format, `eval|random|${i}`, cache)));
	const mut = stats(Array.from({ length: reps }, (_, i) => runBaseline(r, "mutate", seedSet, rounds, results[0]!.arms.length, usersPerArm, format, `eval|mutate|${i}`, cache)));
	// history heuristic: best marginal value per layer (traffic-weighted ipm in the CSV)
	const hist = readJsonIf<any>(PATHS.history);
	const histLayers = Object.fromEntries(LAYER_NAMES.map((l) => [l, Object.entries<any>(hist.layers[l]).sort((a, b) => b[1].all.ipm - a[1].all.ipm)[0]![0]])) as Layers;
	const histIpm = r.audience.expected(histLayers, format).ipm;
	const row = (policy: string, label: string, v: number, sd?: number) => ({ policy, label, final_true_ipm: v, sd, regret: best.ipm - v, pct_of_optimum: (v - worst.ipm) / (best.ipm - worst.ipm) });
	const out = {
		optimum_ipm: best.ipm,
		optimum_label: LAYER_NAMES.map((l) => best.layers[l]).join(" / "),
		worst_ipm: worst.ipm,
		control_ipm: trueOf(control),
		top5: opt.slice(0, 5),
		agent_trajectory: agentTraj,
		rows: [
			row("agent", `LLM agent (${r.cfg.models.strategist})`, final.true_ipm),
			row("mutate", `mutate-1 baseline (mean of ${reps})`, mut.mean, mut.sd),
			row("random", `random-search baseline (mean of ${reps})`, rand.mean, rand.sd),
			row("history", "history heuristic (no experiments)", histIpm),
			row("control", "round-0 control (no loop)", trueOf(control)),
		],
		note: "pct_of_optimum is scaled between the worst (0%) and best (100%) creative in the catalog. Baselines use a Poisson readout with the same users per arm per round as the agent's run.",
	};
	writeJson(join(r.paths.dir, "eval.json"), out);
	for (const x of out.rows) log.info(`${x.label.padEnd(44)} true ipm ${x.final_true_ipm.toFixed(2)}${x.sd ? ` ± ${x.sd.toFixed(2)}` : ""}  regret ${x.regret.toFixed(2)}  (${Math.round(100 * x.pct_of_optimum)}% of optimum)`);
	log.ok(`optimum: ${out.optimum_label} (${best.ipm.toFixed(2)}) → ${join(r.paths.dir, "eval.json")}`);
}
