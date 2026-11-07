// Experimentation platform. One round = one experiment; one arm (group) = one manifest, served through the
// experiment parameter `variant_id`. Statsig does assignment (its SDK hashing) and receives every exposure and
// outcome event; the local platform is a drop-in for offline runs and tests (same interface, sha256 bucketing).
import { Statsig, StatsigUser } from "@statsig/statsig-node-core";
import { errMsg, log, sha256, sleep } from "../util/core.ts";

export type ArmSpec = { group: string; variant_id: string; creative_key: string; is_control: boolean };
export type ExperimentSpec = { name: string; round: number; hypothesis: string; description: string; arms: ArmSpec[] };
export type CreatedExperiment = {
	platform: "statsig" | "local";
	id: string;
	name: string;
	groups: { name: string; id?: string; variant_id: string; is_control: boolean }[];
	created_at: string;
	status: string;
	console_url?: string;
	metrics?: string[];
};
export type SimUser = { userID: string; segment: string; os: string };
export type UserOutcome = { impressions: number; clicks: number; installed: boolean };

export interface Platform {
	readonly kind: "statsig" | "local";
	createOrGet(spec: ExperimentSpec): Promise<CreatedExperiment>;
	/** Prepare assignment for a started experiment (Statsig: download specs and wait until the experiment is live). */
	open(exp: CreatedExperiment): Promise<void>;
	assign(exp: CreatedExperiment, user: SimUser): string | undefined;
	record(exp: CreatedExperiment, user: SimUser, variantId: string, o: UserOutcome, mode: "per_user" | "per_impression"): number;
	flush(): Promise<void>;
	close(): Promise<void>;
	pulse?(exp: CreatedExperiment): Promise<unknown>;
}

// ---------------------------------------------------------------- local
export class LocalPlatform implements Platform {
	readonly kind = "local" as const;
	async createOrGet(spec: ExperimentSpec): Promise<CreatedExperiment> {
		return {
			platform: "local",
			id: spec.name,
			name: spec.name,
			groups: spec.arms.map((a) => ({ name: a.group, variant_id: a.variant_id, is_control: a.is_control })),
			created_at: new Date().toISOString(),
			status: "active",
		};
	}
	async open(): Promise<void> {}
	assign(exp: CreatedExperiment, user: SimUser): string {
		const bucket = parseInt(sha256(`${exp.name}.${user.userID}`).slice(0, 8), 16) % 10000;
		const i = Math.floor((bucket * exp.groups.length) / 10000);
		return exp.groups[i]!.variant_id;
	}
	record(): number {
		return 0;
	}
	async flush(): Promise<void> {}
	async close(): Promise<void> {}
}

// ---------------------------------------------------------------- statsig
const CONSOLE = "https://statsigapi.net/console/v1";

export class StatsigPlatform implements Platform {
	readonly kind = "statsig" as const;
	private readonly serverKey: string;
	private readonly consoleKey: string;
	private sdk: Statsig | undefined;
	private pending = 0;
	private serving = new Set<string>();
	constructor(serverKey: string, consoleKey: string) {
		this.serverKey = serverKey;
		this.consoleKey = consoleKey;
	}

	private async api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
		for (let attempt = 0; ; attempt++) {
			const r = await fetch(`${CONSOLE}${path}`, {
				method,
				headers: { "STATSIG-API-KEY": this.consoleKey, "Content-Type": "application/json", "STATSIG-API-VERSION": "20240601" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await r.text();
			let json: any;
			try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
			if ((r.status === 429 || r.status >= 500) && attempt < 4) {
				await sleep(1500 * (attempt + 1));
				continue;
			}
			return { status: r.status, json };
		}
	}

	/** Verify keys: console key can list experiments, server key can initialize the SDK. */
	async check(): Promise<{ console: string; server: string }> {
		const r = await this.api("GET", "/experiments?limit=1");
		const consoleOk = r.status === 200 ? "ok" : `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`;
		let serverOk = "ok";
		try {
			const s = new Statsig(this.serverKey, { outputLogLevel: "none" } as any);
			const res: any = await s.initialize();
			if (res && res.isSuccess === false) serverOk = `initialize failed: ${res.error ?? "unknown"}`;
			await s.shutdown();
		} catch (e) {
			serverOk = errMsg(e);
		}
		return { console: consoleOk, server: serverOk };
	}

	private toCreated(d: any, spec?: ExperimentSpec): CreatedExperiment {
		const byName = new Map((spec?.arms ?? []).map((a) => [a.group, a]));
		return {
			platform: "statsig",
			id: d.id,
			name: d.name,
			status: d.status,
			created_at: new Date(d.createdTime ?? Date.now()).toISOString(),
			groups: (d.groups ?? []).map((g: any) => ({
				name: g.name,
				id: g.id,
				variant_id: String(g.parameterValues?.variant_id ?? byName.get(g.name)?.variant_id ?? g.name),
				is_control: d.controlGroupID ? g.id === d.controlGroupID : (byName.get(g.name)?.is_control ?? false),
			})),
			metrics: (d.primaryMetrics ?? []).map((m: any) => `${m.name}::${m.type}`),
		};
	}

	async createOrGet(spec: ExperimentSpec): Promise<CreatedExperiment> {
		const id = spec.name.toLowerCase();
		const existing = await this.api("GET", `/experiments/${encodeURIComponent(id)}`);
		if (existing.status === 200 && existing.json?.data) {
			const d = existing.json.data;
			if (d.status === "setup") await this.start(d.id);
			log.info(`statsig: reusing experiment ${d.id} (${d.status})`);
			return this.toCreated({ ...d, status: d.status === "setup" ? "active" : d.status }, spec);
		}
		const sizes = spec.arms.map(() => Math.floor(10000 / spec.arms.length) / 100);
		sizes[sizes.length - 1] = Math.round((100 - sizes.slice(0, -1).reduce((a, b) => a + b, 0)) * 100) / 100;
		const control = spec.arms.findIndex((a) => a.is_control);
		const ordered = [spec.arms[control]!, ...spec.arms.filter((_, i) => i !== control)];
		const body: Record<string, unknown> = {
			name: spec.name,
			idType: "userID",
			description: spec.description.slice(0, 1000),
			hypothesis: spec.hypothesis.slice(0, 1000),
			allocation: 100,
			groups: ordered.map((a, i) => ({
				name: a.group,
				size: sizes[i],
				parameterValues: { variant_id: a.variant_id, creative_key: a.creative_key },
				description: a.is_control ? "control (current champion)" : "challenger",
			})),
			primaryMetrics: [{ name: "app_install", type: "event_count" }],
			secondaryMetrics: [{ name: "ad_click", type: "event_count" }, { name: "ad_impression", type: "event_count" }],
		};
		let r = await this.api("POST", "/experiments", body);
		if (r.status >= 400 && r.status < 500) {
			// Event metrics only exist after the first events arrive; create without them and attach later.
			log.warn(`statsig: create with metrics failed (${r.status}: ${JSON.stringify(r.json).slice(0, 160)}); retrying without metrics`);
			delete body.primaryMetrics;
			delete body.secondaryMetrics;
			r = await this.api("POST", "/experiments", body);
		}
		if (r.status >= 300) throw new Error(`statsig create experiment failed: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
		const d = r.json.data;
		const controlId = (d.groups ?? []).find((g: any) => g.name === spec.arms[control]!.group)?.id;
		if (controlId && !d.controlGroupID) {
			await this.api("PATCH", `/experiments/${encodeURIComponent(d.id)}`, { controlGroupID: controlId });
			d.controlGroupID = controlId;
		}
		await this.start(d.id);
		log.ok(`statsig: created + started experiment ${d.id} (${spec.arms.length} groups)`);
		return this.toCreated({ ...d, status: "active" }, spec);
	}

	private async start(id: string): Promise<void> {
		const r = await this.api("PUT", `/experiments/${encodeURIComponent(id)}/start`, {});
		if (r.status >= 300 && !JSON.stringify(r.json).toLowerCase().includes("already")) {
			throw new Error(`statsig start failed: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
		}
	}

	async open(exp: CreatedExperiment): Promise<void> {
		if (this.sdk && this.serving.has(exp.name)) return;
		const probe = new StatsigUser({ userID: "probe-user-0", custom: { segment: "rpg", os: "ios" } });
		const deadline = Date.now() + 180_000;
		for (let attempt = 0; Date.now() < deadline; attempt++) {
			if (!this.sdk) {
				this.sdk = new Statsig(this.serverKey, {
					specsSyncIntervalMs: 5000,
					eventLoggingFlushIntervalMs: 2000,
					eventLoggingMaxQueueSize: 5000,
					outputLogLevel: "warn",
				} as any);
				await this.sdk.initialize();
			}
			const e = this.sdk.getExperiment(probe, exp.name.toLowerCase(), { disableExposureLogging: true } as any);
			const v = e.get("variant_id", "");
			if (v && e.groupName) {
				log.ok(`statsig: SDK serving ${exp.name} (probe → ${e.groupName}, rule ${e.ruleID})`);
				this.serving.add(exp.name);
				return;
			}
			log.info(`statsig: waiting for experiment specs to propagate (rule=${e.ruleID || "none"})...`);
			await sleep(5000);
			if (attempt % 4 === 3) {
				await this.sdk.shutdown();
				this.sdk = undefined;
				this.serving.clear();
			}
		}
		throw new Error(`statsig: experiment ${exp.name} not served by the SDK after 3 minutes`);
	}

	private user(u: SimUser): StatsigUser {
		return new StatsigUser({ userID: u.userID, custom: { segment: u.segment, os: u.os } });
	}

	assign(exp: CreatedExperiment, u: SimUser): string | undefined {
		const e = this.sdk!.getExperiment(this.user(u), exp.name.toLowerCase());
		const v = e.get("variant_id", "");
		return v || undefined;
	}

	record(exp: CreatedExperiment, u: SimUser, variantId: string, o: UserOutcome, mode: "per_user" | "per_impression"): number {
		const user = this.user(u);
		const meta = { variant_id: variantId, experiment: exp.name, segment: u.segment };
		let n = 0;
		if (mode === "per_impression") {
			for (let i = 0; i < o.impressions; i++) { this.sdk!.logEvent(user, "ad_impression", 1, meta); n++; }
			for (let i = 0; i < o.clicks; i++) { this.sdk!.logEvent(user, "ad_click", 1, meta); n++; }
		} else {
			this.sdk!.logEvent(user, "ad_impression", o.impressions, meta); n++;
			if (o.clicks > 0) { this.sdk!.logEvent(user, "ad_click", o.clicks, meta); n++; }
		}
		if (o.installed) { this.sdk!.logEvent(user, "app_install", 1, meta); n++; }
		this.pending += n;
		return n;
	}

	async flush(): Promise<void> {
		if (this.sdk && this.pending > 0) {
			await this.sdk.flushEvents();
			this.pending = 0;
		}
	}

	async close(): Promise<void> {
		if (this.sdk) {
			await this.sdk.shutdown();
			this.sdk = undefined;
		}
	}

	/** Pulse results per test group vs control. Usually empty until Statsig's daily/hourly load has run. */
	async pulse(exp: CreatedExperiment): Promise<unknown> {
		const control = exp.groups.find((g) => g.is_control) ?? exp.groups[0]!;
		const out: Record<string, unknown> = {};
		for (const g of exp.groups) {
			if (g === control || !g.id || !control.id) continue;
			const r = await this.api("GET", `/experiments/${encodeURIComponent(exp.id)}/pulse_results?control=${control.id}&test=${g.id}&confidence=95`);
			out[g.variant_id] = r.status === 200 ? r.json.data ?? r.json : { error: `HTTP ${r.status}`, detail: r.json };
		}
		return out;
	}

	/** Planned horizon = the simulated traffic (replaces Statsig's default 14-day duration). */
	async setTarget(exp: CreatedExperiment, targetExposures: number): Promise<boolean> {
		const r = await this.api("PATCH", `/experiments/${encodeURIComponent(exp.id)}`, { targetExposures: Math.max(1, Math.round(targetExposures)) });
		return r.status < 300;
	}

	/** Ask Statsig to (re)compute Pulse now. Best effort: availability depends on the plan. */
	async loadPulse(exp: CreatedExperiment): Promise<string> {
		const r = await this.api("POST", `/experiments/${encodeURIComponent(exp.id)}/load_pulse`, { refresh: "full" });
		return r.status < 300 ? "loading" : `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 160)}`;
	}

	/** Write the round's readout back as the experiment decision (ship the winning group). */
	async conclude(exp: CreatedExperiment, winnerVariant: string, reason: string): Promise<string> {
		const cur = await this.api("GET", `/experiments/${encodeURIComponent(exp.id)}`);
		const d = cur.json?.data;
		if (d && ["decision_made", "abandoned", "archived"].includes(d.status)) return `already ${d.status}`;
		const g = (d?.groups ?? []).find((x: any) => String(x.parameterValues?.variant_id) === winnerVariant || x.name === winnerVariant);
		if (!g?.id) return `winner group ${winnerVariant} not found`;
		const r = await this.api("PUT", `/experiments/${encodeURIComponent(exp.id)}/make_decision`, { id: g.id, decisionReason: reason.slice(0, 1000) });
		return r.status < 300 ? "decision_made" : `HTTP ${r.status}: ${JSON.stringify(r.json).slice(0, 200)}`;
	}

	/** Attach event metrics once events exist (they are created by Statsig on first ingestion). */
	async attachMetrics(exp: CreatedExperiment): Promise<boolean> {
		const r = await this.api("PATCH", `/experiments/${encodeURIComponent(exp.id)}`, {
			primaryMetrics: [{ name: "app_install", type: "event_count" }],
			secondaryMetrics: [{ name: "ad_click", type: "event_count" }, { name: "ad_impression", type: "event_count" }],
		});
		return r.status < 300;
	}
}
