// Configuration: config/default.json <- config/local.json <- CLI flags, plus secrets from .env / environment.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, readJsonIf } from "./util/core.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type Lang = "en" | "zh";
export type Config = {
	campaign: string;
	rounds: number;
	seed: number;
	languages: Lang[];
	budget_usd: number;
	models: {
		strategist: string;
		strategist_thinking: "off" | "minimal" | "low" | "medium" | "high";
		planner: string;
		verifier: string;
		image: string;
		image_quality: "low" | "medium" | "high" | "auto";
	};
	render: {
		policy: "seed_and_final" | "all" | "none";
		max_redo: number;
		image_concurrency: number;
		render_concurrency: number;
		aspect: "9:16";
		duration_s: number;
	};
	experiment: {
		platform: "statsig" | "local";
		arms: number;
		max_layers_changed: number;
		mde_relative: number;
		alpha: number;
		power: number;
		users_per_arm_min: number;
		users_per_arm_max: number;
		looks: number;
		early_stop: boolean;
		guardrail_ctr_drop: number;
		statsig_event_mode: "per_user" | "per_impression";
	};
	review: { mode: "auto" | "human"; max_revisions: number };
	memory: { read: boolean; write: boolean };
};

export type Secrets = {
	openrouter?: string;
	statsigServer?: string;
	statsigConsole?: string;
};

function deepMerge<T>(base: T, over: unknown): T {
	if (over === null || typeof over !== "object" || Array.isArray(over)) return (over === undefined ? base : (over as T));
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
		if (k.startsWith("_")) continue;
		out[k] = k in out && typeof out[k] === "object" && !Array.isArray(out[k]) ? deepMerge(out[k], v) : v;
	}
	return out as T;
}

/** Apply dotted overrides like {"experiment.platform": "local"}. */
function applyDotted(cfg: Record<string, unknown>, dotted: Record<string, string>): void {
	for (const [path, raw] of Object.entries(dotted)) {
		const keys = path.split(".");
		let o = cfg;
		for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
		const last = keys[keys.length - 1]!;
		let v: unknown = raw;
		if (raw === "true" || raw === "false") v = raw === "true";
		else if (raw !== "" && !Number.isNaN(Number(raw))) v = Number(raw);
		else if (raw.includes(",") && last === "languages") v = raw.split(",");
		else if (last === "languages") v = [raw];
		o[last] = v;
	}
}

export function loadConfig(dotted: Record<string, string> = {}): Config {
	let cfg = readJson<Config>(join(ROOT, "config/default.json"));
	const local = readJsonIf<Partial<Config>>(join(ROOT, "config/local.json"));
	if (local) cfg = deepMerge(cfg, local);
	applyDotted(cfg as unknown as Record<string, unknown>, dotted);
	delete (cfg as Record<string, unknown>)._doc;
	return cfg;
}

/** Load KEY=VALUE lines from .env into process.env without overwriting real environment variables. */
export function loadDotEnv(path = join(ROOT, ".env")): void {
	if (!existsSync(path)) return;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!m || line.trim().startsWith("#")) continue;
		const v = m[2]!.replace(/^["']|["']$/g, "");
		if (process.env[m[1]!] === undefined) process.env[m[1]!] = v;
	}
}

export function secrets(): Secrets {
	return {
		openrouter: process.env.OPENROUTER_API_KEY || undefined,
		statsigServer: process.env.STATSIG_SERVER_SECRET || undefined,
		statsigConsole: process.env.STATSIG_CONSOLE_KEY || undefined,
	};
}

export const PATHS = {
	root: ROOT,
	runs: join(ROOT, "runs"),
	cache: join(ROOT, "cache"),
	keyframeCache: join(ROOT, "cache/keyframes"),
	models: join(ROOT, "models"),
	audienceModel: join(ROOT, "models/audience_model.json"),
	history: join(ROOT, "models/history_summary.json"),
	catalog: join(ROOT, "data/catalog.json"),
	csv: join(ROOT, "data/creative_performance.csv.gz"),
	py: join(ROOT, "py"),
	memory: join(ROOT, "memory"),
	deliverables: join(ROOT, "deliverables"),
};

export type RunPaths = ReturnType<typeof runPaths>;
export function runPaths(runId: string) {
	const dir = join(PATHS.runs, runId);
	return {
		id: runId,
		dir,
		harness: join(dir, "harness.sqlite"),
		config: join(dir, "config.json"),
		ledger: join(dir, "ledger.jsonl"),
		trace: join(dir, "trace.jsonl"),
		html: join(dir, "trace.html"),
		trajectory: join(dir, "trajectory.md"),
		state: join(dir, "state.json"),
		round: (n: number) => join(dir, "rounds", `r${n}`),
		manifest: (id: string) => join(dir, "manifests", `${id}.json`),
		variantDir: (id: string) => join(dir, "variants", id),
		feedback: join(dir, "feedback.md"),
	};
}
