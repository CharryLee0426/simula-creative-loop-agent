// `npm run setup` (interactive, idempotent) and `npm run doctor` (read-only checks).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, loadDotEnv, PATHS, secrets } from "./config.ts";
import { StatsigPlatform } from "./experiment/platform.ts";
import { log, run } from "./util/core.ts";

const ENV_PATH = join(PATHS.root, ".env");
const KEYS = [
	{ name: "OPENROUTER_API_KEY", required: true, help: "OpenRouter key (https://openrouter.ai/keys) — LLM agent, GPT Image 2.6, Muse Spark video review" },
	{ name: "STATSIG_SERVER_SECRET", required: false, help: "Statsig Server Secret Key (console → Settings → Keys & Environments, starts with secret-)" },
	{ name: "STATSIG_CONSOLE_KEY", required: false, help: "Statsig Console API Key, read/write (same page, Generate New Key → Console, starts with console-)" },
	{ name: "STATSIG_PROJECT_ID", required: false, help: "Statsig project id from the console URL (console.statsig.com/<id>/...), only for links in the report" },
];

function readEnvFile(): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(ENV_PATH)) return out;
	for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
		const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
		if (m) out[m[1]!] = m[2]!;
	}
	return out;
}
function writeEnvFile(v: Record<string, string>): void {
	writeFileSync(ENV_PATH, Object.entries(v).filter(([, x]) => x).map(([k, x]) => `${k}=${x}`).join("\n") + "\n");
	chmodSync(ENV_PATH, 0o600);
}

async function have(cmd: string, args: string[] = ["--version"]): Promise<string | null> {
	try {
		const r = await run(cmd, args);
		return r.code === 0 ? (r.stdout || r.stderr).split("\n")[0]!.trim() : null;
	} catch {
		return null;
	}
}

export async function setup(): Promise<void> {
	const nonInteractive = process.argv.includes("--yes") || !process.stdin.isTTY;
	log.head("1/5 tools");
	const [maj, min] = process.versions.node.split(".").map(Number) as [number, number];
	if (maj < 22 || (maj === 22 && min < 19)) throw new Error(`Node ${process.versions.node} is too old; need >= 22.19 (Pi Durable + native TypeScript)`);
	log.ok(`node ${process.versions.node}`);
	for (const t of ["ffmpeg", "ffprobe"]) {
		const v = await have(t, ["-version"]);
		if (!v) throw new Error(`${t} not found. Install it (macOS: brew install ffmpeg; Ubuntu: sudo apt-get install -y ffmpeg) and rerun.`);
		log.ok(v);
	}
	const uv = await have("uv");
	if (!uv) throw new Error("uv not found. Install it: curl -LsSf https://astral.sh/uv/install.sh | sh  (or: brew install uv), then rerun.");
	log.ok(uv);

	log.head("2/5 keys (.env, never committed)");
	const env = readEnvFile();
	const rl = nonInteractive ? undefined : createInterface({ input: process.stdin, output: process.stdout });
	for (const k of KEYS) {
		const current = env[k.name] || process.env[k.name];
		if (current) { env[k.name] = current; log.ok(`${k.name} set (${current.slice(0, 10)}…)`); continue; }
		if (!rl) { if (k.required) throw new Error(`${k.name} missing; set it in the environment or .env`); log.warn(`${k.name} not set (${k.help})`); continue; }
		const ans = (await rl.question(`${k.name}${k.required ? "" : " (Enter to skip)"}\n  ${k.help}\n  > `)).trim();
		if (ans) env[k.name] = ans;
		else if (k.required) throw new Error(`${k.name} is required`);
	}
	rl?.close();
	writeEnvFile(env);
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	if (!env.STATSIG_SERVER_SECRET || !env.STATSIG_CONSOLE_KEY) {
		log.warn("Statsig keys not set: runs will need --local (offline platform). Add them later by rerunning setup.");
		const localPath = join(PATHS.root, "config/local.json");
		if (!existsSync(localPath)) writeFileSync(localPath, JSON.stringify({ experiment: { platform: "local" } }, null, 2) + "\n");
	}

	log.head("3/5 Python env (uv) + font");
	let r = await run("uv", ["sync", "--project", PATHS.py]);
	if (r.code !== 0) throw new Error(`uv sync failed: ${r.stderr.slice(-600)}`);
	log.ok("py/.venv ready (numpy, pandas, Pillow)");
	r = await run("uv", ["run", "--project", PATHS.py, "python", join(PATHS.py, "renderer/fetch_font.py")]);
	if (r.code !== 0) throw new Error(`font download failed: ${r.stderr.slice(-400)}`);
	log.ok(r.stdout.trim().split("\n").pop() ?? "font ok");

	log.head("4/5 audience model");
	if (!existsSync(PATHS.audienceModel) || process.argv.includes("--refit")) {
		r = await run("uv", ["run", "--project", PATHS.py, "python", join(PATHS.py, "audience/fit.py"), "--csv", PATHS.csv, "--out", PATHS.models]);
		if (r.code !== 0) throw new Error(`fit failed: ${r.stderr.slice(-600)}`);
		log.ok("fitted models/audience_model.json");
	} else log.ok("models/audience_model.json present (use --refit to refit)");

	log.head("5/5 doctor");
	await doctor();
	log.head("ready");
	console.log(`  quick offline smoke test:  npm run loop -- --local --no-render --scale 0.25 --rounds 1 --set memory.write=false
  full run (Statsig):        npm run loop
  trace:                     runs/<run-id>/trace.html`);
}

export async function doctor(): Promise<void> {
	loadDotEnv();
	const cfg = loadConfig();
	let bad = 0;
	const check = (ok: boolean, msg: string, hint = "") => { ok ? log.ok(msg) : (bad++, log.err(`${msg}${hint ? ` — ${hint}` : ""}`)); };
	check(!!(await have("ffmpeg", ["-version"])), "ffmpeg", "install ffmpeg");
	check(existsSync(join(PATHS.py, ".venv")), "python venv (py/.venv)", "npm run setup");
	check(existsSync(join(PATHS.py, "renderer/assets/fonts/NotoSerifCJKsc-Bold.otf")), "font", "npm run setup");
	check(existsSync(PATHS.audienceModel), "audience model", "npm run fit");
	const s = secrets();
	if (!s.openrouter) check(false, "OPENROUTER_API_KEY", "npm run setup");
	else {
		const k = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${s.openrouter}` } }).then((x) => x.json()).catch((e) => ({ error: String(e) })) as any;
		check(!!k?.data, `OpenRouter key${k?.data ? ` (usage $${Number(k.data.usage ?? 0).toFixed(2)}${k.data.limit ? ` of $${k.data.limit}` : ""})` : ""}`, JSON.stringify(k?.error ?? k).slice(0, 120));
		const chat = await fetch("https://openrouter.ai/api/v1/models").then((x) => x.json()).catch(() => ({ data: [] })) as any;
		const img = await fetch("https://openrouter.ai/api/v1/models?output_modalities=image").then((x) => x.json()).catch(() => ({ data: [] })) as any;
		const ids = new Set([...(chat.data ?? []), ...(img.data ?? [])].map((m: any) => m.id));
		for (const [role, id] of [["strategist", cfg.models.strategist], ["planner", cfg.models.planner], ["verifier", cfg.models.verifier], ["image", cfg.models.image]] as const) {
			check(ids.has(id), `model ${role}: ${id}`, "not listed on OpenRouter; change config/local.json");
		}
	}
	if (cfg.experiment.platform === "statsig") {
		if (!s.statsigServer || !s.statsigConsole) check(false, "Statsig keys", "npm run setup, or set experiment.platform=local");
		else {
			const res = await new StatsigPlatform(s.statsigServer, s.statsigConsole).check();
			check(res.console === "ok", `Statsig console API key: ${res.console}`);
			check(res.server === "ok", `Statsig server SDK key: ${res.server}`);
		}
	} else log.info("experiment.platform = local (Statsig not used)");
	if (bad) { log.err(`${bad} problem(s)`); process.exitCode = 1; } else log.ok("all checks passed");
}
