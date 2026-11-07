// The loop as Pi Durable tasks. Every phase commits a checkpoint before the next starts, so a crash or Ctrl-C
// resumes at the phase it stopped in. Phases are also idempotent against the run directory (they skip work whose
// output file exists), which makes a fresh loop task on the same run pick up where an older one ended.
//
//   LoopTask ── RoundTask(0) ── VideoTask × 8 (parallel: plan → keyframes → render → verify, ≤3 redos)
//            ├─ RoundTask(1..R)   (propose → review → experiment → simulate×looks → analyze → record)
//            └─ VideoTask(final champion) → report
import { defineTask, UsageDoc } from "@earendil-works/pi-durable";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Lang } from "../config.ts";
import { takeHumanFeedback, roundMessage } from "../agent/context.ts";
import type { Proposal } from "../agent/validator.ts";
import { analyze, decisionReason, shouldStopEarly, type RoundResult } from "../experiment/analyze.ts";
import type { CreatedExperiment, ExperimentSpec } from "../experiment/platform.ts";
import { StatsigPlatform } from "../experiment/platform.ts";
import { mergeBatches, simulateBatch, type BatchAgg } from "../experiment/simulate.ts";
import { BudgetExceeded } from "../ledger.ts";
import { describeDiff, diffLayers, type Manifest } from "../manifest.ts";
import { ensureKeyframes, renderVideo, verifyVideo, writePlan, type CreativePlan, type Verdict } from "../render/creative.ts";
import { writeReport } from "../report/html.ts";
import { allManifests, loadManifest, loadState, rc, roundResults, saveState } from "../runtime.ts";
import { achievableMde, usersPerArm } from "../stats.ts";
import { ensureDir, errMsg, fmtUsd, readJson, readJsonIf, writeJson } from "../util/core.ts";

type Ctx = Parameters<Parameters<typeof defineTask>[0]["abort"]>[2];
const running = <S>(checkpoint: S) => ({ status: "running" as const, checkpoint });
const done = <R>(result: R) => ({ status: "terminal" as const, outcome: { status: "completed" as const, result } });
const failed = (message: string) => ({ status: "terminal" as const, outcome: { status: "failed" as const, error: { message } } });
const abortTask = (_t: unknown, rt: any, c: Ctx) => rt.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), c);

// =====================================================================================================
// VideoTask: one manifest -> verified MP4s in every configured language
// =====================================================================================================
export type VideoInput = { variant_id: string; round: number; purpose: "seed" | "final" | "manual" };
type VideoState = { phase: "plan"; attempt: number } | { phase: "keyframes"; attempt: number } | { phase: "render"; attempt: number } | { phase: "verify"; attempt: number };
export type AttemptSummary = { attempt: number; pass: boolean; score: number; issues: string[]; reused: [boolean, boolean]; error?: string };
export type VideoResult = { variant_id: string; purpose: string; passed: boolean; best_attempt: number; score: number; attempts: AttemptSummary[]; videos: Record<string, string> };

function attemptDir(id: string, n: number): string {
	return ensureDir(join(rc().paths.variantDir(id), `a${n}`));
}

function attemptSummaries(id: string, upTo: number): AttemptSummary[] {
	const out: AttemptSummary[] = [];
	for (let i = 0; i <= upTo; i++) {
		const s = readJsonIf<AttemptSummary>(join(rc().paths.variantDir(id), `a${i}`, "attempt.json"));
		if (s) out.push(s);
	}
	return out;
}

function finalizeVideo(input: VideoInput, attempt: number): VideoResult {
	const r = rc();
	const attempts = attemptSummaries(input.variant_id, attempt);
	const rendered = attempts.filter((a) => !a.error);
	const best = [...rendered].sort((a, b) => Number(b.pass) - Number(a.pass) || b.score - a.score)[0];
	const videos: Record<string, string> = {};
	if (best) {
		for (const lang of r.cfg.languages) {
			const src = join(r.paths.variantDir(input.variant_id), `a${best.attempt}`, `${lang}.mp4`);
			const dst = join(r.paths.variantDir(input.variant_id), `${input.variant_id}_${lang}.mp4`);
			if (existsSync(src)) { copyFileSync(src, dst); videos[lang] = dst; }
		}
	}
	const result: VideoResult = { variant_id: input.variant_id, purpose: input.purpose, passed: !!best?.pass, best_attempt: best?.attempt ?? -1, score: best?.score ?? 0, attempts, videos };
	writeJson(join(r.paths.variantDir(input.variant_id), "summary.json"), result);
	r.trace.emit(input.round, "variant_video_done",
		`${input.variant_id}: ${result.passed ? "verified ✓" : best ? "not verified after max redos → kept best attempt" : "no usable render"} (best attempt a${result.best_attempt}, score ${result.score}, ${attempts.length} attempt(s))`, result);
	return result;
}

export const VideoTask = defineTask<VideoInput, VideoState, VideoResult>({
	name: "app.video",
	version: 1,
	initial: () => ({ phase: "plan", attempt: 0 }),
	phases: {
		plan: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const { variant_id, round } = task.input;
			const n = task.state.checkpoint.attempt;
			const planPath = join(attemptDir(variant_id, n), "plan.json");
			try {
				if (!existsSync(planPath)) {
					const m = loadManifest(r.paths, variant_id);
					let previous: { plan: CreativePlan; verdicts: Verdict[] } | undefined;
					if (n > 0) {
						const pd = join(r.paths.variantDir(variant_id), `a${n - 1}`);
						const prevPlan = readJsonIf<CreativePlan>(join(pd, "plan.json"));
						const verdicts = r.cfg.languages.map((l) => readJsonIf<Verdict>(join(pd, `verdict_${l}.json`))).filter((v): v is Verdict => !!v);
						const err = readJsonIf<AttemptSummary>(join(pd, "attempt.json"))?.error;
						if (err && prevPlan) verdicts.push({ lang: "en", pass: false, score: 0, checks: {} as any, issues: [{ target: "other", problem: `production error: ${err}`, fix: "adjust the plan or the visual notes so the step can succeed" }], summary: err, spec: {} as any, model: "" });
						if (prevPlan) previous = { plan: prevPlan, verdicts };
					}
					const plan = await writePlan({ cfg: r.cfg, ledger: r.ledger, m, round, attempt: n, previous });
					writeJson(planPath, plan);
					r.trace.emit(round, "render_attempt", `${variant_id} a${n}: plan — en "${plan.lines.en ?? ""}"${plan.lines.zh ? ` / zh "${plan.lines.zh}"` : ""}${n > 0 ? ` (redo ${n}: ${plan.rationale})` : ""}`, { plan }, true);
				}
				await rt.commit(() => running({ phase: "keyframes" as const, attempt: n }), c);
			} catch (e) {
				if (e instanceof BudgetExceeded) await rt.commit(() => done(finalizeVideo(task.input, n - 1)), c);
				else await rt.commit(() => failed(`plan failed: ${errMsg(e)}`), c);
			}
		},
		keyframes: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const { variant_id, round } = task.input;
			const n = task.state.checkpoint.attempt;
			const dir = attemptDir(variant_id, n);
			try {
				if (!existsSync(join(dir, "keyframes.json"))) {
					const m = loadManifest(r.paths, variant_id);
					const plan = readJson<CreativePlan>(join(dir, "plan.json"));
					const kf = await r.imageSem.run(() => ensureKeyframes({ cfg: r.cfg, ledger: r.ledger, m, notes: plan.visual_notes, round }));
					writeJson(join(dir, "keyframes.json"), kf);
					r.trace.emit(round, "render_attempt", `${variant_id} a${n}: keyframes ${kf.reused[0] ? "f1 reused" : "f1 generated"}, ${kf.reused[1] ? "f2 reused" : "f2 generated"}`, kf, true);
				}
				await rt.commit(() => running({ phase: "render" as const, attempt: n }), c);
			} catch (e) {
				await recordAttemptError(task.input, n, e, rt, c);
			}
		},
		render: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const { variant_id } = task.input;
			const n = task.state.checkpoint.attempt;
			const dir = attemptDir(variant_id, n);
			try {
				const m = loadManifest(r.paths, variant_id);
				const plan = readJson<CreativePlan>(join(dir, "plan.json"));
				const kf = readJson<any>(join(dir, "keyframes.json"));
				await Promise.all(r.cfg.languages.map((lang) => {
					const out = join(dir, `${lang}.mp4`);
					return existsSync(out) ? undefined : r.renderSem.run(() => renderVideo({ cfg: r.cfg, m, plan, kf, lang, out }));
				}));
				await rt.commit(() => running({ phase: "verify" as const, attempt: n }), c);
			} catch (e) {
				await recordAttemptError(task.input, n, e, rt, c);
			}
		},
		verify: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const { variant_id, round } = task.input;
			const n = task.state.checkpoint.attempt;
			const dir = attemptDir(variant_id, n);
			try {
				const m = loadManifest(r.paths, variant_id);
				const plan = readJson<CreativePlan>(join(dir, "plan.json"));
				const kf = readJson<any>(join(dir, "keyframes.json"));
				const verdicts = await Promise.all(r.cfg.languages.map(async (lang: Lang) => {
					const vp = join(dir, `verdict_${lang}.json`);
					const cached = readJsonIf<Verdict>(vp);
					if (cached) return cached;
					const v = await r.reviewSem.run(() => verifyVideo({ cfg: r.cfg, ledger: r.ledger, m, plan, lang, path: join(dir, `${lang}.mp4`), round }));
					writeJson(vp, v);
					return v;
				}));
				const pass = verdicts.every((v) => v.pass);
				const score = Math.round(verdicts.reduce((s, v) => s + v.score, 0) / verdicts.length);
				const issues = verdicts.flatMap((v) => v.issues.map((i) => `[${v.lang}] ${i.target}: ${i.problem}`));
				writeJson(join(dir, "attempt.json"), { attempt: n, pass, score, issues, reused: kf.reused } satisfies AttemptSummary);
				r.trace.emit(round, "verification", `${variant_id} a${n}: ${pass ? "PASS" : "FAIL"} score ${score}${issues.length ? ` — ${issues.slice(0, 2).join(" | ")}` : ""}`, { verdicts: verdicts.map((v) => ({ lang: v.lang, pass: v.pass, score: v.score, issues: v.issues, summary: v.summary, spec_ok: v.spec.ok })) });
				if (pass || n >= r.cfg.render.max_redo) await rt.commit(() => done(finalizeVideo(task.input, n)), c);
				else await rt.commit(() => running({ phase: "plan" as const, attempt: n + 1 }), c);
			} catch (e) {
				await recordAttemptError(task.input, n, e, rt, c);
			}
		},
	} as any,
	abort: abortTask as any,
});

async function recordAttemptError(input: VideoInput, n: number, e: unknown, rt: any, c: Ctx): Promise<void> {
	const r = rc();
	const msg = errMsg(e);
	writeJson(join(attemptDir(input.variant_id, n), "attempt.json"), { attempt: n, pass: false, score: 0, issues: [msg], reused: [false, false], error: msg } satisfies AttemptSummary);
	r.trace.emit(input.round, "error", `${input.variant_id} a${n}: ${msg}`);
	if (e instanceof BudgetExceeded || n >= r.cfg.render.max_redo) await rt.commit(() => done(finalizeVideo(input, n)), c);
	else await rt.commit(() => running({ phase: "plan" as const, attempt: n + 1 }), c);
}

// =====================================================================================================
// RoundTask: propose → review → (render) → experiment → simulate (looks) → analyze → record
// =====================================================================================================
export type RoundInput = { round: number };
type RoundState =
	| { phase: "propose"; revision: number }
	| { phase: "review"; revision: number }
	| { phase: "render" }
	| { phase: "render_wait"; tasks: string[] }
	| { phase: "experiment" }
	| { phase: "simulate"; look: number }
	| { phase: "analyze"; looks: number; early: boolean }
	| { phase: "record" };
export type RoundOutput = { round: number; winner: string; champion: string; decision: string };

export function experimentName(runId: string, round: number): string {
	return `rk_${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}_r${round}`.slice(0, 100);
}

async function recordStrategistCost(round: number, rt: any, c: Ctx): Promise<void> {
	const r = rc();
	const st = loadState(r.paths);
	if (!st.strategist_conversation) return;
	const usage: any = await rt.snapshot(UsageDoc, st.strategist_conversation, c);
	const total = Object.values<any>(usage?.models ?? {}).reduce((s, u) => s + (u?.cost?.total ?? 0), 0);
	const prev = readJsonIf<{ usd: number }>(join(r.paths.dir, "strategist_cost.json"))?.usd ?? 0;
	if (total - prev > 1e-9) {
		r.ledger.record({ round, kind: "llm_strategist", model: r.cfg.models.strategist, usd: total - prev, note: "Pi Durable conversation usage delta" });
		writeJson(join(r.paths.dir, "strategist_cost.json"), { usd: total });
	}
}

function proposalPath(round: number): string {
	return join(rc().paths.round(round), "proposal.json");
}

export const RoundTask = defineTask<RoundInput, RoundState, RoundOutput>({
	name: "app.round",
	version: 1,
	initial: () => ({ phase: "propose", revision: 0 }),
	phases: {
		propose: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const n = task.input.round;
			const rev = task.state.checkpoint.revision;
			ensureDir(r.paths.round(n));
			if (existsSync(join(r.paths.round(n), "results.json"))) return void (await rt.commit(() => running({ phase: "record" as const }), c));
			if (!existsSync(proposalPath(n))) {
				const st = loadState(r.paths);
				if (rev === 0) r.trace.emit(n, "round_start", `round ${n} — strategist is ${n === 0 ? "designing generation 0" : `reading round ${n - 1} results`}`);
				const conv = await rt.conversation(st.strategist_conversation as any, c);
				if (!conv) return void (await rt.commit(() => failed("strategist conversation missing"), c));
				const feedbackPath = r.paths.feedback;
				const content = rev === 0
					? roundMessage({ cfg: r.cfg, round: n, manifests: allManifests(r.paths), results: roundResults(r.paths).filter((x) => x.round < n), state: st, feedback: takeHumanFeedback(feedbackPath, n), budgetLeft: r.ledger.remaining() })
					: readJsonIf<{ text: string }>(join(r.paths.round(n), `revision_${rev}.json`))?.text ?? `You did not get an accepted proposal yet. Call submit_generation now for round ${n} and fix every problem it reports.`;
				r.ledger.guard(0.4, "strategist turn");
				writeJson(join(r.paths.round(n), `prompt_${rev}.json`), { content });
				const sub = await conv.submit({ type: "input", content, requestId: `r${n}-propose-${rev}` }, c);
				const settled: any = await sub.wait(c);
				await recordStrategistCost(n, rt, c);
				if (!existsSync(proposalPath(n))) {
					if (rev >= 3) return void (await rt.commit(() => failed(`strategist produced no valid proposal (${settled.status})`), c));
					return void (await rt.commit(() => running({ phase: "propose" as const, revision: rev + 1 }), c));
				}
			}
			const p = readJson<Proposal & { diffs: Record<string, string>; control: string; variant_ids: string[]; warnings: string[] }>(proposalPath(n));
			r.trace.emit(n, "proposal", `proposal: ${p.summary}`, {
				summary: p.summary, hypotheses: p.hypotheses, control: p.control, diffs: p.diffs, warnings: p.warnings,
				variants: p.variant_ids.map((id, i) => ({ id, rationale: p.variants[i]?.rationale, hypothesis_id: p.variants[i]?.hypothesis_id })),
				learnings: p.learnings,
			});
			await rt.commit(() => running({ phase: "review" as const, revision: rev }), c);
		},
		review: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const n = task.input.round;
			const rev = task.state.checkpoint.revision;
			if (r.cfg.review.mode !== "human" || !r.ask || rev >= r.cfg.review.max_revisions + 3) {
				r.trace.emit(n, "review", r.cfg.review.mode === "human" ? "review: revision limit reached, accepted" : "review: auto-approved (review.mode=auto, AI validator is the gate)");
				return void (await rt.commit(() => running({ phase: "render" as const }), c));
			}
			const p = readJson<any>(proposalPath(n));
			const lines = p.variant_ids.map((id: string) => `  ${id}${id === p.control ? " (control)" : ""}: ${p.diffs[id]}`);
			const answer = (await r.ask(`\nRound ${n} proposal\n  ${p.summary}\n${lines.join("\n")}\nApprove? [Enter/y = approve, or type feedback to send back]: `)).trim();
			if (answer === "" || /^y(es)?$/i.test(answer)) {
				r.trace.emit(n, "review", "review: approved by human");
				return void (await rt.commit(() => running({ phase: "render" as const }), c));
			}
			r.trace.emit(n, "review", `review: human sent it back — "${answer}"`);
			renameSync(proposalPath(n), join(r.paths.round(n), `proposal_rejected_${rev}.json`));
			writeJson(join(r.paths.round(n), `revision_${rev + 1}.json`), { text: `The campaign manager reviewed your proposal and sent it back:\n"${answer}"\nRevise and call submit_generation again for round ${n}.` });
			await rt.commit(() => running({ phase: "propose" as const, revision: rev + 1 }), c);
		},
		render: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const n = task.input.round;
			const policy = r.cfg.render.policy;
			const p = readJson<{ variant_ids: string[] }>(proposalPath(n));
			if (!(policy === "all" || (policy === "seed_and_final" && n === 0))) {
				r.trace.emit(n, "note", `render skipped for round ${n} (render.policy=${policy}); the experiment evaluates manifests`, undefined, true);
				return void (await rt.commit(() => running({ phase: "experiment" as const }), c));
			}
			r.trace.emit(n, "note", `rendering ${p.variant_ids.length} variants in parallel (×${r.cfg.languages.length} languages, ≤${r.cfg.render.max_redo} redos each)`);
			await rt.commit(async (tx: any) => {
				const ids: string[] = [];
				for (const id of p.variant_ids) ids.push(await tx.createTask(VideoTask, { variant_id: id, round: n, purpose: "seed" }, { ownership: { kind: "task", taskId: task.id } }));
				return { status: "waiting", checkpoint: { phase: "render_wait", tasks: ids }, on: ids, policy: "allSettled" } as any;
			}, c);
		},
		render_wait: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const n = task.input.round;
			const outcomes = await rt.outcomes(task.state.checkpoint.tasks as any, c);
			const summary = outcomes.map((o: any) => (o.status === "completed" ? o.result : { failed: o.error?.message ?? o.status }));
			writeJson(join(r.paths.round(n), "render_summary.json"), summary);
			const ok = summary.filter((s: any) => s.passed).length;
			r.trace.emit(n, "note", `renders done: ${ok}/${summary.length} verified on first pass or after redos`);
			await rt.commit(() => running({ phase: "experiment" as const }), c);
		},
		experiment: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const n = task.input.round;
			const dir = r.paths.round(n);
			const p = readJson<Proposal & { control: string; variant_ids: string[]; diffs: Record<string, string> }>(proposalPath(n));
			let exp = readJsonIf<CreatedExperiment>(join(dir, "experiment.json"));
			if (!exp) {
				const manifests = allManifests(r.paths);
				const ids = n === 0 ? p.variant_ids : [p.control, ...p.variant_ids];
				const spec: ExperimentSpec = {
					name: experimentName(r.paths.id, n),
					round: n,
					hypothesis: p.summary,
					description: `Rune Keepers creative loop, run ${r.paths.id}, round ${n}. Arms: ${ids.map((id) => `${id}${id === p.control ? " (control)" : ""}: ${p.diffs[id] ?? "control"}`).join(" | ")}`,
					arms: ids.map((id) => ({ group: id, variant_id: id, creative_key: manifests.get(id)!.creative_key, is_control: id === p.control })),
				};
				exp = await r.platform.createOrGet(spec);
				if (exp.platform === "statsig" && process.env.STATSIG_PROJECT_ID) exp.console_url = `https://console.statsig.com/${process.env.STATSIG_PROJECT_ID}/experiments/${exp.id}`;
				writeJson(join(dir, "experiment.json"), exp);
				r.trace.emit(n, "experiment_created", `experiment ${exp.name} on ${exp.platform} with ${exp.groups.length} arms`, exp);
			}
			if (!existsSync(join(dir, "sample_size.json"))) {
				// Base rate for sizing comes from what we already know (history for round 0, the control's last readout after),
				// never from the audience model itself.
				const prev = roundResults(r.paths).filter((x) => x.round < n).flatMap((x) => x.arms).filter((a) => a.variant_id === p.control).pop();
				const hist = readJsonIf<any>(join(r.paths.dir, "..", "..", "models", "history_summary.json"));
				const pUser = prev ? prev.installs / Math.max(1, prev.users) : (hist ? hist.totals.all.installs / hist.totals.all.impressions * 1.45 : 0.005);
				const e = r.cfg.experiment;
				const need = usersPerArm(pUser, e.mde_relative, e.alpha, e.power, exp.groups.length - 1);
				const perArm = Math.min(e.users_per_arm_max, Math.max(e.users_per_arm_min, need));
				const mde = achievableMde(pUser, perArm, e.alpha, e.power, exp.groups.length - 1);
				const plan = { base_install_per_user: pUser, base_source: prev ? `control ${p.control} in round ${n - 1}` : "historical average", target_mde: e.mde_relative, users_needed_per_arm: need, users_per_arm: perArm, achievable_mde: mde, arms: exp.groups.length, total_users: perArm * exp.groups.length, looks: e.looks, alpha: e.alpha, power: e.power };
				writeJson(join(dir, "sample_size.json"), plan);
				if (r.platform instanceof StatsigPlatform) await r.platform.setTarget(exp, plan.total_users).catch(() => false);
				r.trace.emit(n, "sample_size", `sample size: ${perArm} users/arm (needed ${need} for ${Math.round(100 * e.mde_relative)}% MDE at p=${(100 * pUser).toFixed(2)}%/user; achievable MDE ${Math.round(100 * mde)}%), ${e.looks} looks`, plan);
			}
			await rt.commit(() => running({ phase: "simulate" as const, look: 1 }), c);
		},
		simulate: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const n = task.input.round;
			const k = task.state.checkpoint.look;
			const dir = r.paths.round(n);
			const exp = readJson<CreatedExperiment>(join(dir, "experiment.json"));
			const plan = readJson<{ total_users: number; looks: number }>(join(dir, "sample_size.json"));
			const manifests = new Map<string, Manifest>(exp.groups.map((g) => [g.variant_id, loadManifest(r.paths, g.variant_id)]));
			const perLook = Math.ceil(plan.total_users / plan.looks);
			const lookPath = join(dir, "sim", `look_${k}.json`);
			if (!existsSync(lookPath)) {
				await r.platform.open(exp);
				const t0 = Date.now();
				const agg = await simulateBatch({ model: r.audience, manifests, platform: r.platform, exp, batch: k, userStart: (k - 1) * perLook, userCount: perLook,
					seed: `${r.cfg.seed}|${r.paths.id}|r${n}`, eventMode: r.cfg.experiment.statsig_event_mode });
				writeJson(lookPath, agg);
				r.trace.emit(n, "simulation_batch", `look ${k}/${plan.looks}: ${perLook} users → ${agg.events} events sent to ${exp.platform}${agg.unassigned ? `, ${agg.unassigned} unassigned` : ""} (${((Date.now() - t0) / 1000).toFixed(1)}s)`, { users: perLook, events: agg.events, unassigned: agg.unassigned });
			}
			const looks: BatchAgg[] = [];
			for (let i = 1; i <= k; i++) looks.push(readJson<BatchAgg>(join(dir, "sim", `look_${i}.json`)));
			const p = readJson<{ control: string }>(proposalPath(n));
			const interim = analyze({ round: n, arms: mergeBatches(looks, [...manifests.keys()]), manifests, parents: allManifests(r.paths), control: p.control, alpha: r.cfg.experiment.alpha, guardrailDrop: r.cfg.experiment.guardrail_ctr_drop, seed: `${r.cfg.seed}|${n}|${k}`, looksUsed: k, stoppedEarly: false });
			const es = shouldStopEarly(interim, k, plan.looks, r.cfg.experiment.alpha);
			if (es.why) r.trace.emit(n, "note", `interim ${es.why}${es.stop ? " → stop early" : ""}`, undefined, true);
			if (r.cfg.experiment.early_stop && es.stop) await rt.commit(() => running({ phase: "analyze" as const, looks: k, early: true }), c);
			else if (k < plan.looks) await rt.commit(() => running({ phase: "simulate" as const, look: k + 1 }), c);
			else await rt.commit(() => running({ phase: "analyze" as const, looks: k, early: false }), c);
		},
		analyze: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const n = task.input.round;
			const dir = r.paths.round(n);
			const { looks: k, early } = task.state.checkpoint;
			const exp = readJson<CreatedExperiment>(join(dir, "experiment.json"));
			const manifests = new Map<string, Manifest>(exp.groups.map((g) => [g.variant_id, loadManifest(r.paths, g.variant_id)]));
			const looks: BatchAgg[] = [];
			for (let i = 1; i <= k; i++) looks.push(readJson<BatchAgg>(join(dir, "sim", `look_${i}.json`)));
			const p = readJson<{ control: string }>(proposalPath(n));
			const res = analyze({ round: n, arms: mergeBatches(looks, [...manifests.keys()]), manifests, parents: allManifests(r.paths), control: p.control, alpha: r.cfg.experiment.alpha, guardrailDrop: r.cfg.experiment.guardrail_ctr_drop, seed: `${r.cfg.seed}|${n}|final`, looksUsed: k, stoppedEarly: early });
			writeJson(join(dir, "results.json"), res);
			if (r.platform instanceof StatsigPlatform && r.cfg.experiment.conclude_on_platform !== false) {
				// Close the loop on Statsig too: metrics attached, horizon = simulated traffic, readout written as the decision.
				await r.platform.attachMetrics(exp).catch(() => false);
				await r.platform.setTarget(exp, res.total_users).catch(() => false);
				const pulse = await r.platform.loadPulse(exp).catch((e) => errMsg(e));
				const status = await r.platform.conclude(exp, res.winner, decisionReason(res, res.total_users, k)).catch((e) => errMsg(e));
				writeJson(join(dir, "experiment.json"), { ...exp, status, decision: { winner: res.winner, status, pulse_load: pulse, at: new Date().toISOString() } });
				r.trace.emit(n, "note", `statsig: decision written for ${exp.name} → ship ${res.winner} (${status}); pulse load: ${pulse}`);
			}
			const w = res.arms.find((a) => a.variant_id === res.winner)!;
			r.trace.emit(n, "analysis", `winner ${res.winner} ipm ${w.ipm.toFixed(2)} [${w.ipm_ci[0].toFixed(2)}, ${w.ipm_ci[1].toFixed(2)}], P(best) ${w.p_best.toFixed(2)} — ${res.decision}`, { winner: res.winner, decision: res.decision, significant: res.winner_significant });
			await rt.commit(() => running({ phase: "record" as const }), c);
		},
		record: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const n = task.input.round;
			const res = readJson<RoundResult>(join(r.paths.round(n), "results.json"));
			const p = readJsonIf<Proposal>(proposalPath(n));
			const st = loadState(r.paths);
			st.rounds = st.rounds.filter((x) => x.round !== n);
			st.rounds.push({ round: n, control: res.control, winner: res.winner, significant: res.winner_significant, decision: res.decision, champion_after: res.winner });
			st.rounds.sort((a, b) => a.round - b.round);
			st.champion = res.winner;
			if (p?.learnings?.length) st.learnings = p.learnings;
			saveState(r.paths, st);
			const cost = r.ledger.byRound()[n]?.total ?? 0;
			r.trace.emit(n, "round_end", `round ${n} done: champion ${res.winner} — round cost ${fmtUsd(cost)}, total ${fmtUsd(r.ledger.total())}`, { cost_by_kind: r.ledger.byRound()[n] ?? {}, total: r.ledger.total() });
			try { writeReport(r); } catch (e) { r.trace.emit(n, "error", `report failed: ${errMsg(e)}`); }
			await rt.commit(() => done({ round: n, winner: res.winner, champion: res.winner, decision: res.decision }), c);
		},
	} as any,
	abort: abortTask as any,
});

// =====================================================================================================
// LoopTask: rounds 0..R, then render + verify the final champion, then the report
// =====================================================================================================
export type LoopInput = { rounds: number };
type LoopState =
	| { phase: "round"; n: number }
	| { phase: "round_wait"; n: number; task: string }
	| { phase: "final" }
	| { phase: "final_wait"; task: string }
	| { phase: "report" };
export type LoopOutput = { champion: string; rounds: number; total_usd: number };

export const LoopTask = defineTask<LoopInput, LoopState, LoopOutput>({
	name: "app.loop",
	version: 1,
	initial: () => ({ phase: "round", n: 0 }),
	phases: {
		round: async (task: any, rt: any, c: Ctx) => {
			const n = task.state.checkpoint.n;
			if (n > task.input.rounds) return void (await rt.commit(() => running({ phase: "final" as const }), c));
			await rt.commit(async (tx: any) => {
				const id = await tx.createTask(RoundTask, { round: n }, { ownership: { kind: "task", taskId: task.id } });
				return { status: "waiting", checkpoint: { phase: "round_wait", n, task: id }, on: [id], policy: "allSettled" } as any;
			}, c);
		},
		round_wait: async (task: any, rt: any, c: Ctx) => {
			const { n, task: child } = task.state.checkpoint;
			const [o] = await rt.outcomes([child] as any, c);
			if ((o as any).status !== "completed") return void (await rt.commit(() => failed(`round ${n} ${(o as any).status}: ${(o as any).error?.message ?? ""}`), c));
			await rt.commit(() => running({ phase: "round" as const, n: n + 1 }), c);
		},
		final: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const st = loadState(r.paths);
			const champ = st.champion!;
			const m = loadManifest(r.paths, champ);
			const existing = readJsonIf<{ passed: boolean; videos: Record<string, string> }>(join(r.paths.variantDir(champ), "summary.json"));
			r.trace.emit(task.input.rounds, "final", `final champion ${champ} (${describeDiff(diffLayers(loadManifest(r.paths, st.rounds[0]!.control).layers, m.layers))} vs the round-0 control)`);
			if (r.cfg.render.policy === "none" || (existing && Object.keys(existing.videos).length)) {
				if (existing) r.trace.emit(task.input.rounds, "final", `${champ} already rendered (${existing.passed ? "verified" : "best effort"}); reusing its videos`);
				return void (await rt.commit(() => running({ phase: "report" as const }), c));
			}
			await rt.commit(async (tx: any) => {
				const id = await tx.createTask(VideoTask, { variant_id: champ, round: task.input.rounds, purpose: "final" }, { ownership: { kind: "task", taskId: task.id } });
				return { status: "waiting", checkpoint: { phase: "final_wait", task: id }, on: [id], policy: "allSettled" } as any;
			}, c);
		},
		final_wait: async (_task: any, rt: any, c: Ctx) => {
			await rt.commit(() => running({ phase: "report" as const }), c);
		},
		report: async (task: any, rt: any, c: Ctx) => {
			const r = rc();
			const st = loadState(r.paths);
			const champ = st.champion!;
			const vs = readJsonIf<{ passed: boolean; score: number; videos: Record<string, string> }>(join(r.paths.variantDir(champ), "summary.json"));
			st.final = { variant_id: champ, videos: vs?.videos ?? {}, verified: !!vs?.passed, score: vs?.score ?? 0 };
			saveState(r.paths, st);
			if (r.cfg.memory?.write !== false) updatePlaybook(st);
			writeReport(r);
			r.trace.emit(task.input.rounds, "final", `done: champion ${champ}, total spend ${fmtUsd(r.ledger.total())}; report → ${r.paths.html}`);
			await rt.commit(() => done({ champion: champ, rounds: task.input.rounds, total_usd: r.ledger.total() }), c);
		},
	} as any,
	abort: abortTask as any,
});

function updatePlaybook(st: ReturnType<typeof loadState>): void {
	const r = rc();
	const path = join(r.paths.dir, "..", "..", "memory", "playbook.json");
	const pb = readJsonIf<{ campaigns: any[] }>(path) ?? { campaigns: [] };
	pb.campaigns = pb.campaigns.filter((x) => x.run_id !== st.run_id);
	pb.campaigns.push({ run_id: st.run_id, finished_at: new Date().toISOString(), champion: st.champion, learnings: st.learnings });
	writeJson(path, pb);
}
