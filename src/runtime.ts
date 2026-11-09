// Process-wide services for the current run. Durable tasks are pure code + checkpoints; everything they talk to
// (config, ledger, trace, platform, audience) is rebuilt from the run directory when a process (re)opens the run.
import { AudienceModel } from "./audience.ts";
import { runPaths, type Config, type RunPaths } from "./config.ts";
import type { Platform } from "./experiment/platform.ts";
import type { RoundResult } from "./experiment/analyze.ts";
import { Ledger } from "./ledger.ts";
import type { Manifest } from "./manifest.ts";
import { Trace } from "./trace.ts";
import { readJsonIf, Semaphore, writeJson, readJson } from "./util/core.ts";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Learning } from "./memory.ts";
export type { Learning };
export type RunState = {
	run_id: string;
	created_at: string;
	/** Pi Durable ids (numbers in SQLite storage); stored raw, never stringified. */
	strategist_conversation?: any;
	loop_task?: any;
	champion?: string;
	rounds: { round: number; control: string; winner: string; significant: boolean; decision: string; champion_after: string }[];
	learnings: Learning[];
	/** Set when the loop ended before cfg.rounds because the search converged. */
	stopped_early?: { after_round: number; reason: string };
	final?: { variant_id: string; videos: Record<string, string>; verified: boolean; score: number };
};

export type RunContext = {
	cfg: Config;
	paths: RunPaths;
	ledger: Ledger;
	trace: Trace;
	audience: AudienceModel;
	platform: Platform;
	imageSem: Semaphore;
	renderSem: Semaphore;
	reviewSem: Semaphore;
	/** Asks the human (stdin) when review.mode = "human". */
	ask?: (question: string) => Promise<string>;
};

let current: RunContext | undefined;
export function setRun(c: RunContext): void {
	current = c;
}
export function rc(): RunContext {
	if (!current) throw new Error("run context not initialized");
	return current;
}

export function makeRunContext(cfg: Config, runId: string, platform: Platform): RunContext {
	const paths = runPaths(runId);
	return {
		cfg,
		paths,
		ledger: new Ledger(paths.ledger, cfg.budget_usd),
		trace: new Trace(paths.trace),
		audience: new AudienceModel(),
		platform,
		imageSem: new Semaphore(cfg.render.image_concurrency),
		renderSem: new Semaphore(cfg.render.render_concurrency),
		reviewSem: new Semaphore(4),
	};
}

// ---------- file-backed state (the human-readable trajectory; durable checkpoints point into it) ----------
export function loadState(paths: RunPaths): RunState {
	return readJsonIf<RunState>(paths.state) ?? { run_id: paths.id, created_at: new Date().toISOString(), rounds: [], learnings: [] };
}
export function saveState(paths: RunPaths, s: RunState): void {
	writeJson(paths.state, s);
}

export function loadManifest(paths: RunPaths, id: string): Manifest {
	return readJson<Manifest>(paths.manifest(id));
}
export function allManifests(paths: RunPaths): Map<string, Manifest> {
	const dir = join(paths.dir, "manifests");
	const out = new Map<string, Manifest>();
	if (!existsSync(dir)) return out;
	for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
		const m = readJson<Manifest>(join(dir, f));
		out.set(m.variant_id, m);
	}
	return out;
}
export function roundResults(paths: RunPaths): RoundResult[] {
	const out: RoundResult[] = [];
	for (let n = 0; ; n++) {
		const r = readJsonIf<RoundResult>(join(paths.round(n), "results.json"));
		if (!r) break;
		out.push(r);
	}
	return out;
}
