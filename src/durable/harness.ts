// Opening the Pi Durable harness for a run: SQLite storage in the run directory, the strategist extension and the
// loop tasks in the registry, and one long-lived strategist conversation whose transcript spans every round.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { strategistExtension } from "../agent/extension.ts";
import { getModels, resolveChatModel } from "../llm.ts";
import { loadState, saveState, type RunContext } from "../runtime.ts";
import { ensureDir, log } from "../util/core.ts";
import { LoopTask, RoundTask, VideoTask } from "./tasks.ts";

export const ctx = BACKGROUND_CONTEXT;

export async function openHarness(r: RunContext): Promise<Harness> {
	ensureDir(r.paths.dir);
	const registry = createRegistry();
	registry.install(strategistExtension());
	registry.install(defineExtension({ name: "creative-loop", tasks: [LoopTask, RoundTask, VideoTask] as any }));
	const storage = await openNodeSqliteStorage(r.paths.harness);
	return Harness.open(storage, {
		models: getModels(),
		registry,
		identity: { attribution: { name: "simula-creative-loop", url: "https://github.com/" } },
		settings: { retry: { maxRetries: 4 }, afterFailedRun: "continue" },
		onReport: (rep: any) => {
			if (rep.kind === "listener_error") return;
			log.warn(`harness ${rep.kind}${rep.task ? ` (${rep.task.kind})` : ""}: ${rep.error?.message ?? rep.reason ?? ""}`);
		},
	} as any, ctx);
}

/** The strategist keeps one conversation for the whole run, so it remembers its own reasoning across rounds. */
export async function ensureStrategist(h: Harness, r: RunContext): Promise<unknown> {
	const st = loadState(r.paths);
	if (st.strategist_conversation && (await h.conversation(st.strategist_conversation as any, ctx))) return st.strategist_conversation;
	await resolveChatModel(r.cfg.models.strategist); // fail fast on an unknown model id
	const conv = await h.createConversation({
		ownership: { kind: "ownerless" },
		agent: {
			model: { provider: "openrouter", modelId: r.cfg.models.strategist },
			thinkingLevel: r.cfg.models.strategist_thinking,
			maxTurns: 6,
		},
	} as any, ctx);
	st.strategist_conversation = conv.id as any;
	saveState(r.paths, st);
	return conv.id as any;
}
