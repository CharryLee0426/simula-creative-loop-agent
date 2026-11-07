#!/usr/bin/env node
// Single entry point. `npm run loop` runs everything end to end; see README for the other commands.
import { cpSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, loadDotEnv, PATHS, runPaths, secrets, type Config } from "./config.ts";
import { ctx, ensureStrategist, openHarness } from "./durable/harness.ts";
import { LoopTask, RoundTask, VideoTask } from "./durable/tasks.ts";
import { LocalPlatform, StatsigPlatform, type CreatedExperiment, type Platform } from "./experiment/platform.ts";
import { writeReport } from "./report/html.ts";
import { loadState, makeRunContext, rc, saveState, setRun } from "./runtime.ts";
import { ensureDir, errMsg, fmtUsd, log, readJson, readJsonIf, readJsonl, run, writeJson, writeText } from "./util/core.ts";

type Flags = { _: string[]; [k: string]: string | boolean | string[] };
function parseArgs(argv: string[]): Flags {
	const f: Flags = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a.startsWith("--")) {
			const [k, v] = a.slice(2).split("=", 2) as [string, string | undefined];
			if (v !== undefined) f[k] = v;
			else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) f[k] = argv[++i]!;
			else f[k] = true;
			if (k === "set") (f.sets = [...((f.sets as string[]) ?? []), String(f[k])]);
		} else f._.push(a);
	}
	return f;
}

function overrides(f: Flags): Record<string, string> {
	const o: Record<string, string> = {};
	if (f.rounds) o.rounds = String(f.rounds);
	if (f.local) o["experiment.platform"] = "local";
	if (f.human) o["review.mode"] = "human";
	if (f.langs) o.languages = String(f.langs);
	if (f["no-render"]) o["render.policy"] = "none";
	if (f.scale) {
		const s = Number(f.scale);
		const base = loadConfig();
		o["experiment.users_per_arm_max"] = String(Math.round(base.experiment.users_per_arm_max * s));
		o["experiment.users_per_arm_min"] = String(Math.round(base.experiment.users_per_arm_min * s));
	}
	for (const s of (f.sets as string[]) ?? []) {
		const [k, v] = s.split("=", 2);
		if (k && v !== undefined) o[k] = v;
	}
	return o;
}

function newRunId(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function makePlatform(cfg: Config): Platform {
	if (cfg.experiment.platform === "local") return new LocalPlatform();
	const s = secrets();
	if (!s.statsigServer || !s.statsigConsole) {
		throw new Error("Statsig keys missing (STATSIG_SERVER_SECRET, STATSIG_CONSOLE_KEY). Run `npm run setup`, or use --local for an offline run.");
	}
	return new StatsigPlatform(s.statsigServer, s.statsigConsole);
}

/** Load or create a run directory; a resumed run keeps its stored config plus explicit CLI overrides. */
function prepareRun(f: Flags): { cfg: Config; runId: string; fresh: boolean } {
	const runId = String(f.run ?? newRunId());
	const paths = runPaths(runId);
	const stored = readJsonIf<Config>(paths.config);
	const cfg = stored ? { ...loadConfig(), ...stored } : loadConfig();
	const o = overrides(f);
	if (Object.keys(o).length) Object.assign(cfg, loadConfigWith(cfg, o));
	ensureDir(paths.dir);
	writeJson(paths.config, cfg);
	return { cfg, runId, fresh: !stored };
}
function loadConfigWith(base: Config, o: Record<string, string>): Config {
	const c = JSON.parse(JSON.stringify(base)) as Record<string, any>;
	for (const [path, raw] of Object.entries(o)) {
		const keys = path.split(".");
		let x = c;
		for (const k of keys.slice(0, -1)) x = x[k] ??= {};
		const last = keys[keys.length - 1]!;
		x[last] = last === "languages" ? raw.split(",") : raw === "true" ? true : raw === "false" ? false : !Number.isNaN(Number(raw)) && raw !== "" ? Number(raw) : raw;
	}
	return c as Config;
}

async function withRun<T>(f: Flags, fn: (h: Awaited<ReturnType<typeof openHarness>>) => Promise<T>): Promise<T> {
	loadDotEnv();
	if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY missing. Run `npm run setup` first.");
	if (!existsSync(PATHS.audienceModel)) throw new Error("audience model missing. Run `npm run fit` (or `npm run setup`).");
	const { cfg, runId, fresh } = prepareRun(f);
	const platform = makePlatform(cfg);
	const r = makeRunContext(cfg, runId, platform);
	if (cfg.review.mode === "human") {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		r.ask = (q) => rl.question(q);
	}
	setRun(r);
	log.head(`run ${runId} ${fresh ? "(new)" : "(resumed)"} · platform ${cfg.experiment.platform} · rounds 0..${cfg.rounds} · languages ${cfg.languages.join("+")} · review ${cfg.review.mode}`);
	log.info(`run dir: ${r.paths.dir}`);
	if (fresh) r.trace.emit(0, "run_start", `run ${runId} started`, { config: cfg }, true);
	const h = await openHarness(r);
	let closing = false;
	const stop = async () => {
		if (closing) process.exit(130);
		closing = true;
		log.warn(`interrupted — state is durable. Resume with: npm run loop -- --run ${runId}`);
		await h.close(ctx).catch(() => undefined);
		await platform.close().catch(() => undefined);
		process.exit(130);
	};
	process.on("SIGINT", stop);
	try {
		await ensureStrategist(h, r);
		return await fn(h);
	} finally {
		process.off("SIGINT", stop);
		await h.close(ctx).catch(() => undefined);
		await platform.close().catch(() => undefined);
	}
}

async function cmdLoop(f: Flags): Promise<void> {
	await withRun(f, async (h) => {
		const r = rc();
		const st = loadState(r.paths);
		let id = st.loop_task;
		const rec = id ? await h.getTask(id as any, ctx) : undefined;
		if (!rec || (rec.state as any).status === "terminal") {
			if (rec && (rec.state as any).outcome?.status === "completed") log.info("loop already finished; regenerating the report");
			else {
				const root = await h.root(ctx); // never call harness reads inside a commit callback: commits are serialized
				id = (await h.commit(async (tx) => tx.createTask(LoopTask, { rounds: r.cfg.rounds }, { ownership: { kind: "conversation" }, conversationId: root.id }), ctx)) as any;
				st.loop_task = id;
				saveState(r.paths, st);
			}
		} else log.info(`resuming loop task ${id}`);
		h.resume();
		const settled: any = await h.waitForTask(id as any, ctx);
		if (process.env.DEBUG) console.log(JSON.stringify(settled).slice(0, 2000));
		const outcome = settled.state?.outcome ?? settled.outcome;
		writeReport(r);
		if (outcome?.status === "completed") {
			log.ok(`done. champion ${outcome.result.champion} · spend ${fmtUsd(r.ledger.total())}`);
			log.ok(`trace: ${r.paths.html}`);
		} else {
			log.err(`loop ended ${outcome?.status}: ${outcome?.error?.message ?? ""}`);
			log.info(`fix the cause, then resume with: npm run loop -- --run ${r.paths.id}`);
			process.exitCode = 1;
		}
	});
}

async function cmdRound(f: Flags): Promise<void> {
	const n = Number(f.round);
	if (!Number.isInteger(n) || n < 0) throw new Error("--round N is required");
	if (n > 0 && !f.run) throw new Error("--run <id> is required for rounds > 0 (the round reads the previous rounds' results)");
	await withRun(f, async (h) => {
		const r = rc();
		if (n > 0 && !existsSync(join(r.paths.round(n - 1), "results.json"))) throw new Error(`round ${n - 1} has no results yet`);
		const root = await h.root(ctx);
		const id = await h.commit(async (tx) => tx.createTask(RoundTask, { round: n }, { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
		h.resume();
		const settled: any = await h.waitForTask(id, ctx);
		const outcome = settled.state?.outcome ?? settled.outcome;
		writeReport(r);
		if (outcome?.status === "completed") log.ok(`round ${n}: ${outcome.result.decision}. trace: ${r.paths.html}`);
		else { log.err(`round ${n} ${outcome?.status}: ${outcome?.error?.message ?? ""}`); process.exitCode = 1; }
	});
}

async function cmdRender(f: Flags): Promise<void> {
	if (!f.run || !f.variant) throw new Error("usage: npm run render -- --run <id> --variant <variant_id>");
	await withRun(f, async (h) => {
		const r = rc();
		const vid = String(f.variant);
		if (!existsSync(r.paths.manifest(vid))) throw new Error(`no manifest ${vid} in run ${r.paths.id}`);
		const root = await h.root(ctx);
		const id = await h.commit(async (tx) => tx.createTask(VideoTask, { variant_id: vid, round: Number(f.round ?? 99), purpose: "manual" as const }, { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
		h.resume();
		const settled: any = await h.waitForTask(id, ctx);
		const o = settled.state?.outcome ?? settled.outcome;
		if (o?.status === "completed") log.ok(`${vid}: ${o.result.passed ? "verified" : "best effort"} (score ${o.result.score}) → ${Object.values(o.result.videos).join(", ")}`);
		else { log.err(`render ${o?.status}: ${o?.error?.message ?? ""}`); process.exitCode = 1; }
		writeReport(r);
	});
}

async function cmdReport(f: Flags): Promise<void> {
	loadDotEnv();
	const runId = String(f.run ?? latestRun());
	const cfg = readJson<Config>(runPaths(runId).config);
	const r = makeRunContext(cfg, runId, new LocalPlatform());
	setRun(r);
	log.ok(`report: ${writeReport(r)}`);
}

async function cmdPulse(f: Flags): Promise<void> {
	loadDotEnv();
	const runId = String(f.run ?? latestRun());
	const paths = runPaths(runId);
	const s = secrets();
	if (!s.statsigServer || !s.statsigConsole) throw new Error("Statsig keys missing");
	const p = new StatsigPlatform(s.statsigServer, s.statsigConsole);
	for (let n = 0; existsSync(join(paths.round(n), "experiment.json")); n++) {
		const exp = readJson<CreatedExperiment>(join(paths.round(n), "experiment.json"));
		if (exp.platform !== "statsig") continue;
		const attached = await p.attachMetrics(exp).catch(() => false);
		const pulse = await p.pulse(exp);
		writeJson(join(paths.round(n), "pulse.json"), { fetched_at: new Date().toISOString(), pulse });
		const ok = Object.values<any>(pulse as any).filter((x) => !x?.error).length;
		log.info(`round ${n} ${exp.name}: metrics ${attached ? "attached" : "not attachable yet (events still ingesting)"}; pulse for ${ok}/${exp.groups.length - 1} test groups${ok ? "" : " (not computed yet — Statsig loads Pulse on a schedule; retry later)"}`);
	}
}

/** Backfill: for every Statsig experiment of a run, set the target to the simulated traffic, trigger a Pulse load and
 *  record the round's readout as the decision (ship the winner). Idempotent. */
async function cmdConclude(f: Flags): Promise<void> {
	loadDotEnv();
	const { decisionReason } = await import("./experiment/analyze.ts");
	const runId = String(f.run ?? latestRun());
	const paths = runPaths(runId);
	const s = secrets();
	if (!s.statsigServer || !s.statsigConsole) throw new Error("Statsig keys missing");
	const p = new StatsigPlatform(s.statsigServer, s.statsigConsole);
	for (let n = 0; existsSync(join(paths.round(n), "results.json")); n++) {
		const exp = readJson<CreatedExperiment>(join(paths.round(n), "experiment.json"));
		if (exp.platform !== "statsig") continue;
		const res = readJson<any>(join(paths.round(n), "results.json"));
		const metrics = await p.attachMetrics(exp).catch(() => false);
		const target = await p.setTarget(exp, res.total_users).catch(() => false);
		const pulse = await p.loadPulse(exp).catch((e) => errMsg(e));
		const status = await p.conclude(exp, res.winner, decisionReason(res, res.total_users, res.looks_used)).catch((e) => errMsg(e));
		writeJson(join(paths.round(n), "experiment.json"), { ...exp, status, decision: { winner: res.winner, status, pulse_load: pulse, at: new Date().toISOString() } });
		log.info(`round ${n} ${exp.name}: metrics ${metrics ? "ok" : "—"} · target ${target ? res.total_users.toLocaleString() + " exposures" : "not set"} · pulse ${pulse} · decision ${status} (ship ${res.winner})`);
	}
}

async function cmdEval(f: Flags): Promise<void> {
	const { runEval } = await import("./eval/offline.ts");
	loadDotEnv();
	const runId = String(f.run ?? latestRun());
	const cfg = readJson<Config>(runPaths(runId).config);
	const r = makeRunContext(cfg, runId, new LocalPlatform());
	setRun(r);
	await runEval(r, Number(f.reps ?? 20));
	writeReport(r);
}

async function cmdExport(f: Flags): Promise<void> {
	const runId = String(f.run ?? latestRun());
	const paths = runPaths(runId);
	const out = ensureDir(join(PATHS.deliverables, runId));
	for (const name of ["trace.html", "trajectory.md", "state.json", "ledger.jsonl", "trace.jsonl", "config.json", "eval.json"]) {
		if (existsSync(join(paths.dir, name))) cpSync(join(paths.dir, name), join(out, name));
	}
	cpSync(join(paths.dir, "manifests"), join(out, "manifests"), { recursive: true });
	cpSync(join(paths.dir, "rounds"), join(out, "rounds"), { recursive: true });
	const vdir = join(paths.dir, "variants");
	if (existsSync(vdir)) for (const id of readdirSync(vdir)) {
		const sd = join(vdir, id);
		ensureDir(join(out, "variants", id));
		for (const file of readdirSync(sd)) if (file.endsWith(".mp4") || file === "summary.json") cpSync(join(sd, file), join(out, "variants", id, file));
		for (const a of readdirSync(sd).filter((x) => /^a\d+$/.test(x))) {
			ensureDir(join(out, "variants", id, a));
			for (const file of readdirSync(join(sd, a)).filter((x) => x.endsWith(".json") && !x.endsWith(".job.json"))) cpSync(join(sd, a, file), join(out, "variants", id, a, file));
		}
	}
	writeText(join(out, "README.md"), deliverablesReadme(runId));
	log.ok(`exported deliverables → ${out}`);
}

/** Landing page for a exported run: what to open first, and links to every video, manifest and experiment. */
function deliverablesReadme(runId: string): string {
	const paths = runPaths(runId);
	const st = loadState(paths);
	const cfg = readJson<Config>(paths.config);
	const ledger = readJsonIf<any>(join(paths.dir, "eval.json"));
	const lines: string[] = [`# Deliverables — run \`${runId}\``, "",
		"Open **[trace.html](trace.html)** in a browser (EN/中文 toggle) for the full trajectory with embedded videos; [trajectory.md](trajectory.md) is the same in Markdown.", "",
		`Platform: ${cfg.experiment.platform} · rounds 0..${cfg.rounds} · languages ${cfg.languages.join(", ")} · models: strategist ${cfg.models.strategist}, images ${cfg.models.image} (${cfg.models.image_quality}), video review ${cfg.models.verifier}`, ""];
	const total = readJsonl<{ usd: number }>(paths.ledger).reduce((s, e) => s + e.usd, 0);
	lines.push(`Total API spend: **$${total.toFixed(2)}** (every call in [ledger.jsonl](ledger.jsonl)).`, "");
	if (st.final) {
		const m = readJsonIf<any>(paths.manifest(st.final.variant_id));
		lines.push("## Final creative", "", `**${st.final.variant_id}** — ${st.final.verified ? "verified by the video model" : "best effort (not verified after max redos)"}, score ${st.final.score}`, "");
		for (const [lang, p] of Object.entries(st.final.videos)) lines.push(`- ${lang}: [variants/${st.final.variant_id}/${basename(p)}](variants/${st.final.variant_id}/${basename(p)})`);
		if (m) lines.push("", "```json", JSON.stringify(m, null, 2), "```");
		lines.push("");
	}
	lines.push("## Generation 0 (seed) videos", "", "| variant | layers | verified | en | zh |", "|---|---|---|---|---|");
	const p0 = readJsonIf<{ variant_ids: string[] }>(join(paths.round(0), "proposal.json"));
	for (const id of p0?.variant_ids ?? []) {
		const s = readJsonIf<any>(join(paths.variantDir(id), "summary.json"));
		const m = readJsonIf<any>(paths.manifest(id));
		const v = (l: string) => (s?.videos?.[l] ? `[mp4](variants/${id}/${id}_${l}.mp4)` : "—");
		lines.push(`| [${id}](manifests/${id}.json) | ${m ? Object.values(m.layers).join(" / ") : ""} | ${s ? (s.passed ? `✓ (a${s.best_attempt})` : `best effort (a${s.best_attempt})`) : "—"} | ${v("en")} | ${v("zh")} |`);
	}
	lines.push("", "## Experiments", "", "| round | experiment | arms | users | decision |", "|---|---|---|---|---|");
	for (let n = 0; existsSync(join(paths.round(n), "results.json")); n++) {
		const exp = readJsonIf<any>(join(paths.round(n), "experiment.json"));
		const r = readJson<any>(join(paths.round(n), "results.json"));
		lines.push(`| ${n} | ${exp?.console_url ? `[${exp.name}](${exp.console_url})` : exp?.name} (${exp?.platform}) | ${r.arms.length} | ${r.total_users.toLocaleString()} | ${r.decision} |`);
	}
	if (ledger?.rows) {
		lines.push("", "## Offline evaluation (ground truth = audience model, never shown to the agent)", "", "| policy | final true ipm | % of optimum |", "|---|---|---|");
		for (const x of ledger.rows) lines.push(`| ${x.label} | ${x.final_true_ipm.toFixed(2)}${x.sd ? ` ± ${x.sd.toFixed(2)}` : ""} | ${Math.round(100 * x.pct_of_optimum)}% |`);
		lines.push("", `Catalog optimum: ${ledger.optimum_label} (true ipm ${ledger.optimum_ipm.toFixed(2)}).`);
	}
	const shots = join(PATHS.deliverables, runId, "statsig_screenshots");
	if (existsSync(shots)) lines.push("", "Statsig console screenshots: " + readdirSync(shots).filter((x) => /\.(png|jpe?g)$/.test(x)).map((x) => `[${x}](statsig_screenshots/${x})`).join(" · "));
	lines.push("", "Layout: `manifests/` every variant · `rounds/r<N>/` prompt, proposal, validation attempts, experiment, sample size, simulated looks, results, Pulse · `variants/<id>/` videos, per-attempt plan / keyframes / verdicts.");
	return lines.join("\n") + "\n";
}

function latestRun(): string {
	if (!existsSync(PATHS.runs)) throw new Error("no runs yet");
	const runs = readdirSync(PATHS.runs).filter((d) => existsSync(join(PATHS.runs, d, "config.json"))).sort();
	if (!runs.length) throw new Error("no runs yet");
	return runs[runs.length - 1]!;
}

async function cmdFit(): Promise<void> {
	log.step("fitting the audience model (py/audience/fit.py)");
	const r = await run("uv", ["run", "--project", PATHS.py, "python", join(PATHS.py, "audience/fit.py"), "--csv", PATHS.csv, "--out", PATHS.models]);
	process.stdout.write(r.stdout);
	if (r.code !== 0) throw new Error(r.stderr.slice(-800));
}

const HELP = `simula creative loop

  npm run setup                     interactive first-time setup (keys, Python env, font, audience model)
  npm run doctor                    check tools, keys and model access
  npm run fit                       refit the audience model from data/creative_performance.csv.gz
  npm run loop -- [options]         full loop: round 0 (seed + render) .. round R, final render, report
  npm run round -- --round N [--run ID]   run exactly one round
  npm run render -- --run ID --variant ID   (re)render + verify one manifest
  npm run report -- [--run ID]      rebuild trace.html / trajectory.md
  npm run eval -- [--run ID]        offline evaluation vs baselines (uses the audience model's ground truth)
  npm run pulse -- [--run ID]       fetch Statsig Pulse results for the run's experiments
  npm run conclude -- [--run ID]    Statsig: target = simulated traffic, load Pulse, write readout as decision (ship winner)
  npm run export -- [--run ID]      copy deliverables (videos, manifests, trace) to deliverables/<run>

loop/round options:
  --run ID         resume or extend a run (default: new run id)
  --rounds N       rounds after the seed round (default 3)
  --local          offline experiment platform instead of Statsig
  --human          ask a human to approve each proposal (default: AI-only, auto-approve)
  --langs en,zh    video languages
  --scale X        multiply the per-arm traffic caps (e.g. 0.25 for a quick test)
  --no-render      skip all video rendering
  --set key=value  any config field, e.g. --set models.image_quality=medium
`;

async function main(): Promise<void> {
	const f = parseArgs(process.argv.slice(2));
	const cmd = f._[0] ?? "help";
	switch (cmd) {
		case "loop": return cmdLoop(f);
		case "round": return cmdRound(f);
		case "render": return cmdRender(f);
		case "report": return cmdReport(f);
		case "pulse": return cmdPulse(f);
		case "eval": return cmdEval(f);
		case "conclude": return cmdConclude(f);
		case "export": return cmdExport(f);
		case "fit": return cmdFit();
		case "setup": return (await import("./setup.ts")).setup();
		case "doctor": return (await import("./setup.ts")).doctor();
		default: console.log(HELP);
	}
}

main().catch((e) => {
	log.err(errMsg(e));
	if (process.env.DEBUG) console.error(e);
	process.exit(1);
});
