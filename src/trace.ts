// Trace: one JSONL event per meaningful step. trace.html and trajectory.md are rendered from it.
import { appendJsonl, log, readJsonl } from "./util/core.ts";

export type TraceEvent = {
	ts: string;
	round: number;
	type:
		| "run_start"
		| "round_start"
		| "proposal"
		| "validation"
		| "review"
		| "render_attempt"
		| "verification"
		| "variant_video_done"
		| "experiment_created"
		| "sample_size"
		| "simulation_batch"
		| "analysis"
		| "round_end"
		| "final"
		| "error"
		| "note";
	msg: string;
	data?: unknown;
};

export class Trace {
	private readonly path: string;
	constructor(path: string) {
		this.path = path;
	}
	emit(round: number, type: TraceEvent["type"], msg: string, data?: unknown, quiet = false): void {
		appendJsonl(this.path, { ts: new Date().toISOString(), round, type, msg, ...(data === undefined ? {} : { data }) });
		if (!quiet) log.step(`[r${round}] ${msg}`);
	}
	all(): TraceEvent[] {
		return readJsonl<TraceEvent>(this.path);
	}
}
