// Cost ledger: every paid call is one JSONL line. The budget guard refuses a call that would cross the cap.
import { appendJsonl, readJsonl } from "./util/core.ts";

export type CostKind = "llm_strategist" | "llm_planner" | "image" | "vlm";
export type CostEntry = {
	ts: string;
	round: number;
	kind: CostKind;
	model: string;
	usd: number;
	variant_id?: string;
	tokens_in?: number;
	tokens_out?: number;
	note?: string;
};

export class BudgetExceeded extends Error {}

export class Ledger {
	private readonly path: string;
	private readonly budget: number;
	private entries: CostEntry[];
	constructor(path: string, budgetUsd: number) {
		this.path = path;
		this.budget = budgetUsd;
		this.entries = readJsonl<CostEntry>(path);
	}
	record(e: Omit<CostEntry, "ts">): void {
		const entry = { ts: new Date().toISOString(), ...e, usd: Math.round(e.usd * 1e6) / 1e6 };
		this.entries.push(entry);
		appendJsonl(this.path, entry);
	}
	total(): number {
		return this.entries.reduce((s, e) => s + e.usd, 0);
	}
	remaining(): number {
		return this.budget - this.total();
	}
	/** Throw before a call whose estimated cost would cross the budget. */
	guard(estimateUsd: number, what: string): void {
		if (this.total() + estimateUsd > this.budget) {
			throw new BudgetExceeded(`budget $${this.budget} would be exceeded by ${what} (spent $${this.total().toFixed(2)}, est. $${estimateUsd.toFixed(2)})`);
		}
	}
	byRound(): Record<number, Record<string, number>> {
		const out: Record<number, Record<string, number>> = {};
		for (const e of this.entries) {
			const r = (out[e.round] ??= { total: 0 });
			r[e.kind] = (r[e.kind] ?? 0) + e.usd;
			r.total = (r.total ?? 0) + e.usd;
		}
		return out;
	}
	all(): CostEntry[] {
		return [...this.entries];
	}
}
