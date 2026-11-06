// Model access through pi-ai (OpenRouter provider) plus small helpers for JSON answers, images and video review.
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import type { CostKind, Ledger } from "./ledger.ts";
import { errMsg, log, sleep } from "./util/core.ts";

let modelsSingleton: ReturnType<typeof createModels> | undefined;
export function getModels() {
	if (!modelsSingleton) {
		modelsSingleton = createModels();
		modelsSingleton.setProvider(openrouterProvider());
	}
	return modelsSingleton;
}

/** Resolve an OpenRouter chat model, refreshing the live catalog once if it is newer than pi-ai's built-in list. */
export async function resolveChatModel(modelId: string) {
	const models = getModels();
	let m = models.getModel("openrouter", modelId);
	if (!m) {
		await models.refresh({ providers: ["openrouter"] }).catch(() => undefined);
		m = models.getModel("openrouter", modelId);
	}
	if (!m) throw new Error(`model openrouter/${modelId} not found in the OpenRouter catalog`);
	return m;
}

function extractJson(text: string): unknown {
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fence ? fence[1]! : text;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("no JSON object in model answer");
	return JSON.parse(body.slice(start, end + 1));
}

/** One-shot JSON completion (OpenRouter chat completions) with retries on transport/parse/validation errors.
 *  Uses fetch directly rather than pi-ai's complete(): pi-ai serializes calls, and the planner runs for eight
 *  variants at once. The agent itself (multi-turn, tools, durable) goes through Pi Durable. */
export async function completeJson<T>(args: {
	modelId: string;
	system: string;
	user: string;
	ledger: Ledger;
	round: number;
	kind: CostKind;
	variantId?: string;
	validate?: (v: T) => string[];
	maxAttempts?: number;
}): Promise<T> {
	const messages: any[] = [{ role: "system", content: args.system }, { role: "user", content: args.user }];
	let lastErr = "";
	for (let attempt = 0; attempt < (args.maxAttempts ?? 3); attempt++) {
		args.ledger.guard(0.05, `${args.kind} call`);
		let text = "";
		try {
			const r = await fetch(`${OR}/chat/completions`, { method: "POST", headers: orHeaders(), signal: AbortSignal.timeout(180_000),
				body: JSON.stringify({ model: args.modelId, messages, temperature: 0.7, max_tokens: 2000 }) });
			const j: any = await r.json().catch(() => ({}));
			if (j.usage) args.ledger.record({ round: args.round, kind: args.kind, model: args.modelId, usd: j.usage.cost ?? 0, variant_id: args.variantId, tokens_in: j.usage.prompt_tokens, tokens_out: j.usage.completion_tokens });
			text = j.choices?.[0]?.message?.content ?? "";
			if (!r.ok || !text) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
		} catch (e) {
			lastErr = errMsg(e);
			await sleep(1500 * (attempt + 1));
			continue;
		}
		try {
			const v = extractJson(text) as T;
			const problems = args.validate?.(v) ?? [];
			if (problems.length === 0) return v;
			lastErr = problems.join("; ");
			messages.push({ role: "assistant", content: text }, { role: "user", content: `Your JSON has problems: ${lastErr}. Return the corrected full JSON only.` });
		} catch (e) {
			lastErr = errMsg(e);
			messages.push({ role: "assistant", content: text }, { role: "user", content: `I could not parse that (${lastErr}). Return only one JSON object.` });
		}
	}
	throw new Error(`${args.kind}: no valid JSON after retries: ${lastErr}`);
}

const OR = "https://openrouter.ai/api/v1";
function orHeaders() {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error("OPENROUTER_API_KEY is not set");
	return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/simula-creative-loop", "X-Title": "simula-creative-loop" };
}

/** OpenRouter Images API (dedicated /images endpoint). Optional reference image for consistent edits. */
export async function generateImage(args: {
	model: string;
	prompt: string;
	quality: string;
	referencePng?: Buffer;
	ledger: Ledger;
	round: number;
	variantId?: string;
	note?: string;
}): Promise<Buffer> {
	const est = args.quality === "high" ? 0.2 : args.quality === "medium" ? 0.06 : 0.03;
	let last = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		args.ledger.guard(est, `image ${args.note ?? ""}`);
		const body: Record<string, unknown> = { model: args.model, prompt: args.prompt, aspect_ratio: "9:16", quality: args.quality, n: 1 };
		if (args.referencePng) body.input_references = [{ type: "image_url", image_url: { url: `data:image/png;base64,${args.referencePng.toString("base64")}` } }];
		try {
			const r = await fetch(`${OR}/images`, { method: "POST", headers: orHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
			const j: any = await r.json().catch(() => ({}));
			if (j.usage?.cost) args.ledger.record({ round: args.round, kind: "image", model: args.model, usd: j.usage.cost, variant_id: args.variantId, note: args.note });
			const b64 = j.data?.[0]?.b64_json;
			if (r.ok && b64) return Buffer.from(b64, "base64");
			last = `HTTP ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 300)}`;
		} catch (e) {
			last = errMsg(e);
		}
		log.warn(`image attempt ${attempt + 1} failed: ${last}`);
		await sleep(3000 * (attempt + 1));
	}
	throw new Error(`image generation failed: ${last}`);
}

/** Video understanding: send an MP4 (base64 data URL) plus a prompt; expect one JSON object back. */
export async function reviewVideo(args: {
	model: string;
	system: string;
	prompt: string;
	mp4?: Buffer;
	/** Fallback when the model cannot read the video: still frames (JPEG) in time order. */
	frames?: Buffer[];
	ledger: Ledger;
	round: number;
	variantId?: string;
}): Promise<{ json: any; raw: string }> {
	let last = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		args.ledger.guard(0.02, "video review");
		try {
			const r = await fetch(`${OR}/chat/completions`, {
				method: "POST",
				headers: orHeaders(),
				signal: AbortSignal.timeout(240_000),
				body: JSON.stringify({
					model: args.model,
					messages: [
						{ role: "system", content: args.system },
						{ role: "user", content: [
							{ type: "text", text: args.prompt },
							...(args.mp4 ? [{ type: "video_url", video_url: { url: `data:video/mp4;base64,${args.mp4.toString("base64")}` } }] : []),
							...(args.frames ?? []).map((f) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${f.toString("base64")}` } })),
						] },
					],
					response_format: { type: "json_object" },
					temperature: 0,
				}),
			});
			const j: any = await r.json().catch(() => ({}));
			if (j.usage?.cost !== undefined) args.ledger.record({ round: args.round, kind: "vlm", model: args.model, usd: j.usage.cost ?? 0, variant_id: args.variantId,
				tokens_in: j.usage.prompt_tokens, tokens_out: j.usage.completion_tokens });
			const text: string = j.choices?.[0]?.message?.content ?? "";
			if (r.ok && text) return { json: extractJson(text), raw: text };
			last = `HTTP ${r.status}: ${JSON.stringify(j.error ?? j).slice(0, 300)}`;
		} catch (e) {
			last = errMsg(e);
		}
		log.warn(`video review attempt ${attempt + 1} failed: ${last}`);
		await sleep(2000 * (attempt + 1));
	}
	throw new Error(`video review failed: ${last}`);
}
