// Small shared helpers: files, hashing, seeded randomness, concurrency, subprocesses, logging.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------- files ----------
export function ensureDir(dir: string): string {
	mkdirSync(dir, { recursive: true });
	return dir;
}
export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}
export function readJsonIf<T>(path: string): T | undefined {
	return existsSync(path) ? readJson<T>(path) : undefined;
}
/** Write via temp file + rename so a crash never leaves half a JSON file. */
export function writeJson(path: string, value: unknown): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
	renameSync(tmp, path);
}
export function writeText(path: string, text: string): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}
export function appendJsonl(path: string, value: unknown): void {
	ensureDir(dirname(path));
	appendFileSync(path, JSON.stringify(value) + "\n");
}
export function readJsonl<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as T);
}

// ---------- hashing ----------
export function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const o = v as Record<string, unknown>;
	return `{${Object.keys(o)
		.sort()
		.filter((k) => o[k] !== undefined)
		.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
		.join(",")}}`;
}
export function sha256(s: string | Buffer): string {
	return createHash("sha256").update(s).digest("hex");
}
export function shortHash(v: unknown, n = 12): string {
	return sha256(typeof v === "string" ? v : stableStringify(v)).slice(0, n);
}

// ---------- seeded randomness ----------
/** sfc32: small, fast, good-quality PRNG. Seeded from a string so every stream is reproducible by name. */
export class Rng {
	private a: number;
	private b: number;
	private c: number;
	private d: number;
	constructor(seed: string | number) {
		const h = createHash("sha256").update(String(seed)).digest();
		this.a = h.readUInt32LE(0);
		this.b = h.readUInt32LE(4);
		this.c = h.readUInt32LE(8);
		this.d = h.readUInt32LE(12);
		for (let i = 0; i < 12; i++) this.next();
	}
	next(): number {
		this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
		let t = (this.a + this.b) | 0;
		this.a = this.b ^ (this.b >>> 9);
		this.b = (this.c + (this.c << 3)) | 0;
		this.c = (this.c << 21) | (this.c >>> 11);
		this.d = (this.d + 1) | 0;
		t = (t + this.d) | 0;
		this.c = (this.c + t) | 0;
		return (t >>> 0) / 4294967296;
	}
	int(n: number): number {
		return Math.floor(this.next() * n);
	}
	pick<T>(xs: readonly T[]): T {
		return xs[this.int(xs.length)]!;
	}
	/** Sample a key from {key: probability}. */
	categorical<K extends string>(probs: Record<K, number>): K {
		const keys = Object.keys(probs) as K[];
		let u = this.next() * keys.reduce((s, k) => s + probs[k], 0);
		for (const k of keys) {
			u -= probs[k];
			if (u <= 0) return k;
		}
		return keys[keys.length - 1]!;
	}
	normal(): number {
		const u = Math.max(this.next(), 1e-12);
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
	}
	/** Marsaglia-Tsang gamma, used for Beta posterior draws. */
	gamma(shape: number): number {
		if (shape < 1) return this.gamma(shape + 1) * Math.pow(this.next(), 1 / shape);
		const d = shape - 1 / 3;
		const c = 1 / Math.sqrt(9 * d);
		for (;;) {
			let x: number, v: number;
			do {
				x = this.normal();
				v = 1 + c * x;
			} while (v <= 0);
			v = v * v * v;
			const u = this.next();
			if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
		}
	}
	beta(a: number, b: number): number {
		const x = this.gamma(a);
		return x / (x + this.gamma(b));
	}
}

// ---------- concurrency ----------
export class Semaphore {
	private queue: Array<() => void> = [];
	private active = 0;
	private readonly limit: number;
	constructor(limit: number) {
		this.limit = Math.max(1, limit);
	}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

// ---------- subprocesses ----------
export type ProcResult = { code: number; stdout: string; stderr: string };
export function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): Promise<ProcResult> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		p.stdout.on("data", (d) => (stdout += d));
		p.stderr.on("data", (d) => (stderr += d));
		p.on("error", reject);
		p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}

// ---------- logging ----------
const COLORS = { dim: "\x1b[2m", reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m" };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
function c(color: keyof typeof COLORS, s: string): string {
	return useColor ? `${COLORS[color]}${s}${COLORS.reset}` : s;
}
function stamp(): string {
	return new Date().toISOString().slice(11, 19);
}
export const log = {
	info: (msg: string) => console.log(`${c("dim", stamp())} ${msg}`),
	step: (msg: string) => console.log(`${c("dim", stamp())} ${c("cyan", "▸")} ${msg}`),
	ok: (msg: string) => console.log(`${c("dim", stamp())} ${c("green", "✓")} ${msg}`),
	warn: (msg: string) => console.log(`${c("dim", stamp())} ${c("yellow", "!")} ${msg}`),
	err: (msg: string) => console.error(`${c("dim", stamp())} ${c("red", "✗")} ${msg}`),
	head: (msg: string) => console.log(`\n${c("bold", msg)}`),
};

export function fmtUsd(x: number): string {
	return `$${x.toFixed(x < 0.1 ? 4 : 2)}`;
}
export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
