// Creative production for one manifest: keyframes (cached per layer), a localized plan (LLM), the deterministic
// render (Python), a spec gate (ffprobe) and the video review (VLM). The durable VideoTask strings these together.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { PATHS, type Config, type Lang } from "../config.ts";
import type { Ledger } from "../ledger.ts";
import { completeJson, generateImage, reviewVideo } from "../llm.ts";
import { catalog, localize, type Manifest } from "../manifest.ts";
import { ensureDir, run, shortHash, writeJson } from "../util/core.ts";

// ------------------------------------------------------------------ keyframes
export type VisualNotes = { f1?: string; f2?: string };

/** Prompts are built from the catalog, not free-written, so a keyframe depends only on the layers it shows:
 *  f1 = background + character, f2 = f1 + action. Changing only hook/cta/audio reuses both images. */
export function keyframePrompts(m: Manifest, notes: VisualNotes = {}): { f1: string; f2: string } {
	const cat = catalog();
	const bg = cat.layers.background[m.layers.background]!;
	const ch = cat.layers.character[m.layers.character]!;
	const act = cat.layers.action[m.layers.action]!;
	const actionText = act.visual.replaceAll("{name}", m.layers.character).replaceAll("{magic}", ch.magic);
	const f1 = [
		cat.brand.art_style,
		`Scene: ${bg.visual}.`,
		`Character: ${ch.visual}. Standing in the scene in a calm three-quarter view, looking toward the viewer, medium-wide establishing shot, face clearly visible.`,
		notes.f1 ? `Art direction fix: ${notes.f1}` : "",
	].filter(Boolean).join(" ");
	const f2 = [
		"Use the reference image: keep exactly the same character, face, outfit, colors, scene and painterly style. Vertical 9:16, full bleed.",
		`New, closer and more dynamic shot: ${actionText}.`,
		"No text, no letters, no logos, no watermark, no blood, no injuries.",
		notes.f2 ? `Art direction fix: ${notes.f2}` : "",
	].filter(Boolean).join(" ");
	return { f1, f2 };
}

export type KeyframeResult = { f1: string; f2: string; f1Key: string; f2Key: string; reused: [boolean, boolean] };

export async function ensureKeyframes(args: { cfg: Config; ledger: Ledger; m: Manifest; notes: VisualNotes; round: number }): Promise<KeyframeResult> {
	const { cfg, m } = args;
	const p = keyframePrompts(m, args.notes);
	const dir = ensureDir(PATHS.keyframeCache);
	const f1Key = shortHash({ model: cfg.models.image, q: cfg.models.image_quality, prompt: p.f1 }, 16);
	const f2Key = shortHash({ model: cfg.models.image, q: cfg.models.image_quality, prompt: p.f2, ref: f1Key }, 16);
	const f1 = join(dir, `${f1Key}.png`);
	const f2 = join(dir, `${f2Key}.png`);
	const reused: [boolean, boolean] = [existsSync(f1), existsSync(f2)];
	if (!reused[0]) {
		const img = await generateImage({ model: cfg.models.image, prompt: p.f1, quality: cfg.models.image_quality, ledger: args.ledger, round: args.round, variantId: m.variant_id, note: "keyframe f1 (background+character)" });
		writeFileSync(f1, img);
		writeJson(`${f1}.json`, { prompt: p.f1, model: cfg.models.image, quality: cfg.models.image_quality, first_variant: m.variant_id });
	}
	if (!reused[1]) {
		const img = await generateImage({ model: cfg.models.image, prompt: p.f2, quality: cfg.models.image_quality, referencePng: readFileSync(f1), ledger: args.ledger, round: args.round, variantId: m.variant_id, note: "keyframe f2 (+action, ref f1)" });
		writeFileSync(f2, img);
		writeJson(`${f2}.json`, { prompt: p.f2, reference: f1Key, model: cfg.models.image, quality: cfg.models.image_quality, first_variant: m.variant_id });
	}
	return { f1, f2, f1Key, f2Key, reused };
}

// ------------------------------------------------------------------ plan (the only LLM-written creative text)
export type CreativePlan = {
	variant_id: string;
	attempt: number;
	lines: Record<Lang, string>;
	tagline: Record<Lang, string>;
	timeline: { cut_s: number; line_in_s: number; line_out_s: number; endcard_s: number };
	visual_notes: VisualNotes;
	rationale: string;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

export function defaultTimeline(duration: number) {
	return { cut_s: Math.round(duration * 0.42 * 10) / 10, line_in_s: 0.35, line_out_s: Math.round(duration * 0.4 * 10) / 10, endcard_s: Math.round((duration - 2) * 10) / 10 };
}

function planProblems(plan: CreativePlan, m: Manifest, langs: Lang[]): string[] {
	const p: string[] = [];
	const d = m.format.duration_s;
	const t = plan.timeline;
	if (!t || [t.cut_s, t.line_in_s, t.line_out_s, t.endcard_s].some((x) => typeof x !== "number")) return ["timeline must have numeric cut_s, line_in_s, line_out_s, endcard_s"];
	if (t.cut_s < 1.6 || t.cut_s > d - 2.4) p.push(`cut_s must be in [1.6, ${d - 2.4}]`);
	if (t.line_in_s < 0.2 || t.line_out_s - t.line_in_s < 1.6) p.push("the line must start at >=0.2s and stay on screen >=1.6s");
	if (t.endcard_s < t.cut_s + 1.0 || t.endcard_s > d - 1.6) p.push(`endcard_s must be >= cut_s+1.0 and <= ${d - 1.6}`);
	if (t.line_out_s > t.endcard_s - 0.2) p.push("line_out_s must end at least 0.2s before endcard_s");
	for (const l of langs) {
		const line = plan.lines?.[l];
		if (!line) { p.push(`lines.${l} missing`); continue; }
		if (l === "en" && !norm(line).includes(norm(m.layers.hook))) p.push(`lines.en must contain the hook "${m.layers.hook}" verbatim`);
		if (l === "en" && line.length > 64) p.push("lines.en must be <= 64 characters");
		if (l === "zh" && [...line].length > 24) p.push("lines.zh must be <= 24 characters");
		if (!plan.tagline?.[l]) p.push(`tagline.${l} missing`);
	}
	return p;
}

export async function writePlan(args: {
	cfg: Config;
	ledger: Ledger;
	m: Manifest;
	round: number;
	attempt: number;
	previous?: { plan: CreativePlan; verdicts: Verdict[] };
}): Promise<CreativePlan> {
	const { cfg, m } = args;
	const cat = catalog();
	const ch = cat.layers.character[m.layers.character]!;
	const langs = cfg.languages;
	const system = `You write the creative plan for a 6-10 second vertical mobile game ad for "${cat.brand.game.en}" (${cat.brand.game.zh}).
Brand tone: ${cat.brand.tone}
The video has two painted keyframes (shot 1: the character in the scene; shot 2 after a cut: the action), one on-screen line spoken by the character during shot 1, and an end card (title, tagline, install button). Visuals, button text, music and title are fixed by code; you write the line, the tagline and the timing.
Rules:
- The hook is the ad's opening line. lines.en MUST contain the hook text verbatim; you may add at most 6 words in the character's voice before or after it. Keep it <= 64 characters.
- lines.zh is a natural Chinese rendering of the same line in the character's voice, <= 24 characters, using the Chinese character name if the name appears.
- tagline: a short end-card tagline per language (<= 40 chars en, <= 16 chars zh); warm, a little dramatic, about recruiting AI companions / adventuring together.
- No gore, no sexual content, no claims you cannot keep.
- timeline (seconds, duration ${m.format.duration_s}): line_in_s >= 0.2, line on screen >= 1.6 s, cut_s in [1.6, ${m.format.duration_s - 2.4}], endcard_s >= cut_s + 1.0 and <= ${m.format.duration_s - 1.6}, line_out_s <= endcard_s - 0.2.
- visual_notes.f1 / visual_notes.f2: leave empty unless a reviewer reported a visual problem in that keyframe; then write one concise art-direction fix (it is appended to the image prompt and forces a regeneration).
Return only JSON: {"lines": {${langs.map((l) => `"${l}": "..."`).join(", ")}}, "tagline": {${langs.map((l) => `"${l}": "..."`).join(", ")}}, "timeline": {"cut_s": n, "line_in_s": n, "line_out_s": n, "endcard_s": n}, "visual_notes": {"f1": "", "f2": ""}, "rationale": "one sentence"}`;
	const feedback = args.previous
		? `\n\nPREVIOUS ATTEMPT ${args.previous.plan.attempt} WAS REJECTED by the video reviewer. Previous plan:\n${JSON.stringify({ lines: args.previous.plan.lines, tagline: args.previous.plan.tagline, timeline: args.previous.plan.timeline, visual_notes: args.previous.plan.visual_notes })}\nReviewer findings (fix every one; keyframe problems need a visual_notes fix for that frame):\n${args.previous.verdicts
				.flatMap((v) => v.issues.map((i) => `- [${v.lang}] ${i.target}: ${i.problem} -> suggested fix: ${i.fix}`))
				.join("\n")}`
		: "";
	const user = `Manifest ${m.variant_id}:
- background: ${m.layers.background} (${cat.layers.background[m.layers.background]!.visual})
- character: ${m.layers.character}, ${ch.visual}; voice: ${ch.voice}; Chinese name ${ch.zh}
- action (shot 2): ${m.layers.action}
- hook: "${m.layers.hook}" (Chinese reference: ${cat.layers.hook[m.layers.hook]!.zh})
- cta button: "${m.layers.cta}" / "${localize("cta", m.layers.cta, "zh")}"
- audio: ${m.layers.audio}
- duration: ${m.format.duration_s}s${feedback}`;
	const raw = await completeJson<Omit<CreativePlan, "variant_id" | "attempt">>({
		modelId: cfg.models.planner, system, user, ledger: args.ledger, round: args.round, kind: "llm_planner", variantId: m.variant_id,
		validate: (v) => planProblems({ ...(v as CreativePlan), variant_id: m.variant_id, attempt: args.attempt }, m, langs),
	});
	const keep = args.previous?.plan.visual_notes ?? {};
	return {
		variant_id: m.variant_id,
		attempt: args.attempt,
		lines: raw.lines,
		tagline: raw.tagline,
		timeline: raw.timeline,
		// visual fixes accumulate across attempts so a regenerated frame does not regress
		visual_notes: { f1: [keep.f1, raw.visual_notes?.f1].filter(Boolean).join(" ") || undefined, f2: [keep.f2, raw.visual_notes?.f2].filter(Boolean).join(" ") || undefined },
		rationale: raw.rationale ?? "",
	};
}

// ------------------------------------------------------------------ render + spec gate
function pythonBin(): string[] {
	const venv = join(PATHS.py, ".venv/bin/python");
	return existsSync(venv) ? [venv] : ["uv", "run", "--project", PATHS.py, "python"];
}

export function styleFor(m: Manifest): string {
	return catalog().layers.background[m.layers.background]!.style;
}

export async function renderVideo(args: { cfg: Config; m: Manifest; plan: CreativePlan; kf: KeyframeResult; lang: Lang; out: string; workers?: number }): Promise<void> {
	const { m, plan, lang } = args;
	const cat = catalog();
	const job = {
		variant_id: m.variant_id,
		lang,
		format: m.format,
		style: styleFor(m),
		audio_preset: cat.layers.audio[m.layers.audio]!.preset,
		keyframes: [args.kf.f1, args.kf.f2],
		timeline: plan.timeline,
		line: plan.lines[lang],
		title: cat.brand.game[lang],
		tagline: plan.tagline[lang],
		cta_label: localize("cta", m.layers.cta, lang),
		out: args.out,
	};
	const jobPath = `${args.out}.job.json`;
	writeJson(jobPath, job);
	const [bin, ...pre] = pythonBin();
	const workers = args.workers ?? Math.max(1, Math.floor(cpus().length / Math.max(1, args.cfg.render.render_concurrency)));
	const r = await run(bin!, [...pre, join(PATHS.py, "renderer/make_video.py"), "--job", jobPath, "--workers", String(workers)]);
	if (r.code !== 0 || !existsSync(args.out)) throw new Error(`render failed (${r.code}): ${(r.stderr || r.stdout).slice(-600)}`);
}

export type SpecGate = { ok: boolean; issues: string[]; duration: number; width: number; height: number; vcodec: string; acodec: string; mean_volume_db: number | null; bytes: number };

/** Hard constraints from the brief: 5-10 s, 9:16, <= 1080x1920, H.264 MP4, has an audio track (audible). */
export async function specGate(path: string): Promise<SpecGate> {
	const pr = await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", path]);
	const j = JSON.parse(pr.stdout || "{}");
	const v = (j.streams ?? []).find((s: any) => s.codec_type === "video") ?? {};
	const a = (j.streams ?? []).find((s: any) => s.codec_type === "audio");
	const duration = Number(j.format?.duration ?? 0);
	const vd = await run("ffmpeg", ["-hide_banner", "-i", path, "-af", "volumedetect", "-vn", "-f", "null", "-"]);
	const mv = vd.stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
	const mean = mv ? Number(mv[1]) : null;
	const issues: string[] = [];
	if (duration < 5 || duration > 10.05) issues.push(`duration ${duration.toFixed(2)}s outside 5-10s`);
	if (!v.width || Math.abs(v.width / v.height - 9 / 16) > 0.01) issues.push(`aspect ${v.width}x${v.height} is not 9:16`);
	if (v.width > 1080 || v.height > 1920) issues.push(`resolution ${v.width}x${v.height} above 1080x1920`);
	if (v.codec_name !== "h264") issues.push(`video codec ${v.codec_name} is not H.264`);
	if (!a) issues.push("no audio track");
	if (mean !== null && mean < -60) issues.push(`audio is near-silent (${mean} dB)`);
	return { ok: issues.length === 0, issues, duration, width: v.width ?? 0, height: v.height ?? 0, vcodec: v.codec_name ?? "", acodec: a?.codec_name ?? "", mean_volume_db: mean, bytes: statSync(path).size };
}

// ------------------------------------------------------------------ verification (VLM)
export type CheckName = "background" | "character" | "action" | "hook_line" | "cta" | "endcard" | "brand_safety";
export type Verdict = {
	lang: Lang;
	pass: boolean;
	score: number;
	checks: Record<CheckName, { pass: boolean; observed: string }>;
	issues: { target: "keyframe1" | "keyframe2" | "line" | "timing" | "endcard" | "other"; problem: string; fix: string }[];
	summary: string;
	spec: SpecGate;
	model: string;
};

const CRITICAL: CheckName[] = ["background", "character", "action", "hook_line", "cta", "brand_safety"];

export async function verifyVideo(args: { cfg: Config; ledger: Ledger; m: Manifest; plan: CreativePlan; lang: Lang; path: string; round: number }): Promise<Verdict> {
	const { cfg, m, plan, lang } = args;
	const cat = catalog();
	const spec = await specGate(args.path);
	const proxy = `${args.path}.review.mp4`;
	await run("ffmpeg", ["-y", "-v", "error", "-i", args.path, "-vf", "scale=540:-2", "-c:v", "libx264", "-crf", "27", "-preset", "veryfast", "-c:a", "aac", "-b:a", "64k", proxy]);
	const ch = cat.layers.character[m.layers.character]!;
	const actionText = cat.layers.action[m.layers.action]!.visual.replaceAll("{name}", m.layers.character).replaceAll("{magic}", ch.magic);
	const system = "You are a strict but fair QA reviewer for video ads. You compare a rendered video against its manifest and report only what you actually see. Answer with one JSON object.";
	const prompt = `This ${m.format.duration_s}s vertical ad must match manifest ${m.variant_id}. Check each item against the video.

EXPECTED
- background: ${m.layers.background} — ${cat.layers.background[m.layers.background]!.visual}
- character: ${ch.visual}
- action (second shot, after a cut): ${actionText}
- hook_line: the on-screen line during the first shot must read exactly: "${plan.lines[lang]}" (language: ${lang === "en" ? "English" : "Simplified Chinese"}); it must express the hook "${m.layers.hook}"
- cta: the end card has an install button whose text is exactly "${localize("cta", m.layers.cta, lang)}"
- endcard: title "${cat.brand.game[lang]}" and tagline "${plan.tagline[lang]}"
- brand_safety: warm, a little dramatic; no gore, no blood, no sexual content; ends on the install call to action
(Audio is checked separately by code; ignore it.)

Rules: a check passes if a typical viewer would agree the video shows it. Small artistic differences are fine; a wrong character, wrong setting, missing action, wrong or garbled text, or a missing button are failures. Text inside the painted images (letters, logos) is a brand_safety problem.

Return JSON:
{"checks": {"background": {"pass": bool, "observed": "..."}, "character": {...}, "action": {...}, "hook_line": {...}, "cta": {...}, "endcard": {...}, "brand_safety": {...}},
 "score": 0-100 (overall faithfulness to the manifest),
 "issues": [{"target": "keyframe1|keyframe2|line|timing|endcard|other", "problem": "...", "fix": "concrete instruction to fix it"}],
 "summary": "one sentence"}`;
	// The reviewer occasionally answers as if it received no video. That is a tooling failure, not a creative failure:
	// retry, then fall back to still frames (shot 1 + line, shot 2, end card) so a glitch never triggers a redo.
	let json: any;
	let mode = "video";
	for (let i = 0; i < 3; i++) {
		json = (await reviewVideo({ model: cfg.models.verifier, system, prompt, mp4: readFileSync(proxy), ledger: args.ledger, round: args.round, variantId: m.variant_id })).json;
		if (!reviewerBlind(json)) break;
		json = undefined;
	}
	if (!json) {
		mode = "frames";
		const tl = plan.timeline;
		const times = [(tl.line_in_s + tl.line_out_s) / 2, tl.cut_s + 0.7, Math.min(m.format.duration_s - 0.3, tl.endcard_s + 1.0)];
		const frames: Buffer[] = [];
		for (const [i, tt] of times.entries()) {
			const fp = `${args.path}.frame${i}.jpg`;
			await run("ffmpeg", ["-y", "-v", "error", "-ss", tt.toFixed(2), "-i", args.path, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", fp]);
			frames.push(readFileSync(fp));
		}
		const framePrompt = `${prompt}\n\n(The video is given as three still frames in time order: ~${times[0]!.toFixed(1)}s shot 1 with the line, ~${times[1]!.toFixed(1)}s shot 2 after the cut, ~${times[2]!.toFixed(1)}s end card.)`;
		json = (await reviewVideo({ model: cfg.models.verifier, system, prompt: framePrompt, frames, ledger: args.ledger, round: args.round, variantId: m.variant_id })).json;
	}
	const checks = {} as Verdict["checks"];
	for (const k of [...CRITICAL, "endcard"] as CheckName[]) {
		const c = json?.checks?.[k] ?? {};
		checks[k] = { pass: c.pass === true, observed: String(c.observed ?? "") };
	}
	const issues: Verdict["issues"] = Array.isArray(json?.issues) ? json.issues.map((i: any) => ({ target: i.target ?? "other", problem: String(i.problem ?? ""), fix: String(i.fix ?? "") })) : [];
	for (const s of spec.issues) issues.push({ target: "other", problem: `spec: ${s}`, fix: "renderer/spec problem" });
	for (const k of CRITICAL) if (!checks[k].pass && !issues.some((i) => i.problem.toLowerCase().includes(k.split("_")[0]!))) {
		issues.push({ target: k === "action" ? "keyframe2" : k === "background" || k === "character" ? "keyframe1" : k === "hook_line" ? "line" : "other", problem: `${k} check failed: ${checks[k].observed}`, fix: `make the ${k.replace("_", " ")} match the manifest` });
	}
	const pass = spec.ok && CRITICAL.every((k) => checks[k].pass);
	let score = Math.max(0, Math.min(100, Number(json?.score ?? 0)));
	if (!spec.ok) score = Math.min(score, 40);
	return { lang, pass, score, checks, issues, summary: `${mode === "frames" ? "[reviewed from frames] " : ""}${String(json?.summary ?? "")}`, spec, model: cfg.models.verifier };
}

/** True when the answer says the model could not see the video at all (most checks cite missing frames). */
export function reviewerBlind(json: any): boolean {
	const obs = Object.values<any>(json?.checks ?? {}).map((c) => String(c?.observed ?? "").toLowerCase());
	const blindRe = /no (video|frames?|visual|footage|content)|not (provided|available|visible)|unable to (view|see|access|verify)|cannot (view|see|access)|no .*available to verify/;
	const n = obs.filter((o) => blindRe.test(o)).length;
	return obs.length === 0 || n >= Math.ceil(obs.length / 2) || blindRe.test(String(json?.summary ?? "").toLowerCase()) && n >= 2;
}
