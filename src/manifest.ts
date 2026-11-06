// Manifest = one creative decomposed into swappable layers. Immutable once written: any edit is a new variant_id
// with parent_id pointing at its source, so "what changed" is always a layer-by-layer diff.
import { PATHS, type Lang } from "./config.ts";
import { readJson, shortHash } from "./util/core.ts";

export const LAYER_NAMES = ["background", "character", "action", "hook", "cta", "audio"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];
export type Layers = Record<LayerName, string>;

/** Manifest layer -> CSV column, so every manifest maps back onto the training data. */
export const CSV_COLUMN: Record<LayerName, string> = {
	background: "background",
	character: "subject_character",
	action: "subject_action",
	hook: "hook_text",
	cta: "cta_text",
	audio: "audio_style",
};

export type Manifest = {
	schema_version: "1.0";
	variant_id: string;
	generation: number;
	parent_id: string | null;
	created_round: number;
	format: { aspect: "9:16"; duration_s: number };
	layers: Layers;
	/** Content hash of the layers + format: equal hashes mean the same creative. */
	creative_key: string;
	hypothesis_id?: string;
	rationale?: string;
};

export function creativeKey(layers: Layers, format: Manifest["format"]): string {
	return shortHash({ layers, format }, 10);
}

export function makeManifest(args: {
	variant_id: string;
	generation: number;
	parent_id: string | null;
	round: number;
	layers: Layers;
	format: Manifest["format"];
	hypothesis_id?: string;
	rationale?: string;
}): Manifest {
	const layers = Object.fromEntries(LAYER_NAMES.map((l) => [l, args.layers[l]])) as Layers;
	return {
		schema_version: "1.0",
		variant_id: args.variant_id,
		generation: args.generation,
		parent_id: args.parent_id,
		created_round: args.round,
		format: args.format,
		layers,
		creative_key: creativeKey(layers, args.format),
		...(args.hypothesis_id ? { hypothesis_id: args.hypothesis_id } : {}),
		...(args.rationale ? { rationale: args.rationale } : {}),
	};
}

export function variantId(generation: number, index: number): string {
	return `g${generation}_v${String(index).padStart(2, "0")}`;
}

export type LayerDiff = { layer: LayerName; from: string; to: string };
export function diffLayers(a: Layers, b: Layers): LayerDiff[] {
	return LAYER_NAMES.filter((l) => a[l] !== b[l]).map((l) => ({ layer: l, from: a[l], to: b[l] }));
}
export function describeDiff(d: LayerDiff[]): string {
	return d.length === 0 ? "(identical)" : d.map((x) => `${x.layer}: ${x.from} → ${x.to}`).join("; ");
}

// ---------- catalog ----------
type Loc = { en: string; zh: string };
export type Catalog = {
	brand: { game: Loc; tagline: Loc; tone: string; art_style: string };
	layers: {
		background: Record<string, Loc & { style: "rune" | "warm"; visual: string }>;
		character: Record<string, Loc & { pronoun: string; magic: string; visual: string; voice: string }>;
		action: Record<string, Loc & { visual: string }>;
		hook: Record<string, Loc & { kind: string }>;
		cta: Record<string, Loc>;
		audio: Record<string, Loc & { preset: string }>;
	};
};

let catalogCache: Catalog | undefined;
export function catalog(): Catalog {
	catalogCache ??= readJson<Catalog>(PATHS.catalog);
	return catalogCache;
}
export function layerValues(layer: LayerName): string[] {
	return Object.keys(catalog().layers[layer]);
}
export function localize(layer: LayerName, value: string, lang: Lang): string {
	const entry = (catalog().layers[layer] as Record<string, Loc>)[value];
	return entry ? entry[lang] : value;
}
export function isValidValue(layer: LayerName, value: string): boolean {
	return value in catalog().layers[layer];
}

/** Soft brand-consistency warnings (allowed, but the agent should know). */
export function brandWarnings(layers: Layers): string[] {
	const w: string[] = [];
	const ch = catalog().layers.character[layers.character];
	if (layers.hook === "She remembers everything." && ch && ch.pronoun !== "she") w.push(`hook "She remembers everything." is about a female companion but the character is ${layers.character}`);
	if (layers.cta === "Join Luna" && layers.character !== "Luna") w.push(`CTA "Join Luna" but the character on screen is ${layers.character}`);
	return w;
}
