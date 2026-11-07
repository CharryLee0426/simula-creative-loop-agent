// trace.html: one self-contained page per run (EN / 中文 toggle). Built only from files in the run directory,
// so it can be regenerated at any time (npm run report -- --run <id>).
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { SEGMENTS } from "../audience.ts";
import type { RoundResult } from "../experiment/analyze.ts";
import { LAYER_NAMES, diffLayers, localize, type LayerName, type Manifest } from "../manifest.ts";
import { allManifests, loadState, roundResults, type RunContext } from "../runtime.ts";
import { readJsonIf, readJsonl, writeText } from "../util/core.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const t = (en: string, zh: string) => `<span class="l-en">${en}</span><span class="l-zh">${zh}</span>`;
const f2 = (x: number) => x.toFixed(2);
const usd = (x: number) => `$${x < 0.1 ? x.toFixed(4) : x.toFixed(2)}`;
const pct = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${(100 * x).toFixed(0)}%`);
const LAYER_ZH: Record<LayerName, string> = { background: "背景", character: "角色", action: "动作", hook: "开场台词", cta: "行动按钮", audio: "音频" };

function layerCell(m: Manifest, changed: string[], lang: "en" | "zh" = "en"): string {
	return LAYER_NAMES.map((l) => `<span class="chip${changed.includes(l) ? " hot" : ""}" title="${l}">${esc(lang === "en" ? m.layers[l] : localize(l, m.layers[l], "zh"))}</span>`).join("");
}

function trajectorySvg(results: RoundResult[]): string {
	if (!results.length) return "";
	const pts = results.map((r) => {
		const w = r.arms.find((a) => a.variant_id === r.winner)!;
		const c = r.arms.find((a) => a.is_control)!;
		return { round: r.round, win: w.ipm, lo: w.ipm_ci[0], hi: w.ipm_ci[1], ctrl: c.ipm };
	});
	const W = 640, H = 220, P = 40;
	const ymax = Math.max(...pts.map((p) => p.hi)) * 1.1 || 1;
	const x = (i: number) => P + (pts.length === 1 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (pts.length - 1));
	const y = (v: number) => H - P + 10 - (v / ymax) * (H - 2 * P);
	const line = (key: "win" | "ctrl") => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
	const ticks = [0, ymax / 2, ymax].map((v) => `<text x="${P - 8}" y="${y(v) + 4}" text-anchor="end" class="ax">${v.toFixed(1)}</text><line x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`).join("");
	return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="ipm by round">
${ticks}
${pts.map((p, i) => `<line x1="${x(i)}" x2="${x(i)}" y1="${y(p.lo)}" y2="${y(p.hi)}" class="ci"/>`).join("")}
<path d="${line("ctrl")}" class="ctrl"/><path d="${line("win")}" class="win"/>
${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.win)}" r="4" class="dot"/><text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="ax">R${p.round}</text><text x="${x(i) + 7}" y="${y(p.win) - 7}" class="val">${p.win.toFixed(2)}</text>`).join("")}
</svg>
<div class="legend"><span class="k win"></span>${t("winner ipm (95% CI)", "胜出变体 ipm（95% 置信区间）")} <span class="k ctrl"></span>${t("control ipm", "对照组 ipm")}</div>`;
}

function videoCard(r: RunContext, id: string, m: Manifest | undefined): string {
	const s = readJsonIf<any>(join(r.paths.variantDir(id), "summary.json"));
	if (!s || !m) return "";
	const vids = Object.entries<string>(s.videos ?? {}).map(([lang, p]) => `<video class="v-${lang}" src="${esc(relative(r.paths.dir, p))}#t=1.2" controls preload="metadata" playsinline></video>`).join("");
	const attempts = (s.attempts ?? []).map((a: any) => `<li class="${a.pass ? "pass" : "fail"}">a${a.attempt}: ${a.pass ? "PASS" : "FAIL"} · ${a.score}${a.reused ? ` · kf ${a.reused.map((x: boolean) => (x ? "♻" : "★")).join("")}` : ""}${a.issues?.length ? `<br><small>${esc(a.issues.slice(0, 3).join(" | "))}</small>` : ""}</li>`).join("");
	return `<figure class="vcard">${vids}<figcaption><b>${esc(id)}</b> <span class="badge ${s.passed ? "pass" : "fail"}">${s.passed ? t("verified", "已通过校验") : t("best effort", "未通过·取最佳")}</span><div class="layers">${layerCell(m, [])}</div><ul class="att">${attempts}</ul></figcaption></figure>`;
}

export function buildReport(r: RunContext): string {
	const st = loadState(r.paths);
	const manifests = allManifests(r.paths);
	const results = roundResults(r.paths);
	const trace = readJsonl<any>(r.paths.trace);
	const costs = r.ledger.byRound();
	const total = r.ledger.total();
	const evalJson = readJsonIf<any>(join(r.paths.dir, "eval.json"));
	const champ = st.champion ? manifests.get(st.champion) : undefined;
	const lastRes = results[results.length - 1];
	const champArm = lastRes?.arms.find((a) => a.variant_id === st.champion);
	const firstCtrl = results[0]?.arms.find((a) => a.is_control);

	const kpis = `<div class="kpis">
<div><small>${t("rounds (experiments)", "轮次（实验数）")}</small><b>${results.length}</b></div>
<div><small>${t("final champion", "最终胜出")}</small><b>${esc(st.champion ?? "—")}</b></div>
<div><small>${t("champion ipm (last readout)", "胜出 ipm（最后一轮）")}</small><b>${champArm ? f2(champArm.ipm) : "—"}</b>${firstCtrl && champArm ? `<small>${t("round-0 control", "第0轮对照")} ${f2(firstCtrl.ipm)}</small>` : ""}</div>
<div><small>${t("users simulated", "模拟用户数")}</small><b>${results.reduce((s, x) => s + x.total_users, 0).toLocaleString()}</b></div>
<div><small>${t("API spend", "API 花费")}</small><b>${usd(total)}</b><small>${t("budget", "预算")} $${r.cfg.budget_usd}</small></div>
<div><small>${t("platform", "实验平台")}</small><b>${esc(r.cfg.experiment.platform)}</b></div>
</div>`;

	const costRows = Object.entries(costs).sort((a, b) => Number(a[0]) - Number(b[0])).map(([rd, c]) =>
		`<tr><td>R${rd}</td><td>${usd(c.llm_strategist ?? 0)}</td><td>${usd(c.llm_planner ?? 0)}</td><td>${usd(c.image ?? 0)}</td><td>${usd(c.vlm ?? 0)}</td><td><b>${usd(c.total ?? 0)}</b></td></tr>`).join("");
	const costTable = `<table class="t"><thead><tr><th>${t("round", "轮次")}</th><th>${t("strategist LLM", "策略 Agent")}</th><th>${t("plan LLM", "脚本 LLM")}</th><th>${t("images", "生图")}</th><th>${t("video review", "视频审核")}</th><th>${t("total", "合计")}</th></tr></thead><tbody>${costRows}<tr class="sum"><td>${t("all", "全部")}</td><td colspan="4"></td><td><b>${usd(total)}</b></td></tr></tbody></table>`;

	const roundSections = results.map((res) => {
		const n = res.round;
		const prop = readJsonIf<any>(join(r.paths.round(n), "proposal.json"));
		const exp = readJsonIf<any>(join(r.paths.round(n), "experiment.json"));
		const ss = readJsonIf<any>(join(r.paths.round(n), "sample_size.json"));
		const attempts = readJsonl<any>(join(r.paths.round(n), "validation_attempts.jsonl"));
		const rejected = attempts.filter((a) => !a.ok);
		const hyps = (prop?.hypotheses ?? []).map((h: any) => `<li><b>${esc(h.id)}</b> ${esc(h.statement)}</li>`).join("");
		const changeRows = (prop?.variant_ids ?? []).map((id: string, i: number) => {
			const m = manifests.get(id)!;
			const parent = m.parent_id ? manifests.get(m.parent_id) : undefined;
			const d = parent ? diffLayers(parent.layers, m.layers) : [];
			const what = parent ? d.map((x) => `<span class="diff"><i>${x.layer}</i> ${esc(x.from)} → <b>${esc(x.to)}</b></span>`).join(" ") : t("new combination", "新组合");
			return `<tr><td><b>${esc(id)}</b></td><td>${esc(m.parent_id ?? "—")}</td><td>${what}</td><td>${esc(prop.variants?.[i]?.hypothesis_id ?? "")}</td><td class="why">${esc(prop.variants?.[i]?.rationale ?? "")}</td></tr>`;
		}).join("");
		const armRows = res.arms.map((a) => {
			const m = manifests.get(a.variant_id)!;
			return `<tr class="${a.variant_id === res.winner ? "winner" : ""}"><td><b>${esc(a.variant_id)}</b>${a.is_control ? ` <span class="badge">${t("control", "对照")}</span>` : ""}${a.variant_id === res.winner ? ` <span class="badge win">${t("winner", "胜出")}</span>` : ""}</td>
<td class="layers">${layerCell(m, a.changed)}</td><td>${a.users.toLocaleString()}</td><td>${a.impressions.toLocaleString()}</td><td>${(100 * a.ctr).toFixed(2)}%</td>
<td><b>${f2(a.ipm)}</b> <small>[${f2(a.ipm_ci[0])}, ${f2(a.ipm_ci[1])}]</small></td><td>${pct(a.lift_vs_control)}</td><td>${a.p_adj === null ? "—" : a.p_adj.toFixed(3)}</td><td>${a.p_best.toFixed(2)}</td>
<td><small>${SEGMENTS.map((s) => f2(a.by_segment[s].ipm)).join(" / ")}</small></td><td>${a.guardrail_ok ? "✓" : "✗"}</td></tr>`;
		}).join("");
		const videos = (prop?.variant_ids ?? []).map((id: string) => videoCard(r, id, manifests.get(id))).filter(Boolean).join("");
		const pulse = readJsonIf<any>(join(r.paths.round(n), "pulse.json"));
		const pulseRows = pulse ? Object.entries<any>(pulse.pulse ?? {}).map(([vid, d]) => {
			if (d?.error) return `<tr><td>${esc(vid)}</td><td colspan="3" class="muted">${esc(d.error)} ${esc(JSON.stringify(d.detail ?? "").slice(0, 120))}</td></tr>`;
			const ms = [...(d?.primaryMetrics ?? []), ...(d?.secondaryMetrics ?? [])];
			return ms.map((mm: any) => `<tr><td>${esc(vid)}</td><td>${esc(mm.metricID ?? mm.name)}</td><td>${mm.percent_change ?? mm.percentChange ?? "—"}</td><td>${mm.p_value ?? mm.pValue ?? "—"}</td></tr>`).join("") || `<tr><td>${esc(vid)}</td><td colspan="3" class="muted">no metrics yet</td></tr>`;
		}).join("") : "";
		const pulseBlock = pulse ? `<h4>${t("Statsig Pulse (Statsig's own readout, fetched", "Statsig Pulse（Statsig 自己的分析，拉取于")} ${esc(String(pulse.fetched_at ?? "").slice(0, 16))})</h4><table class="t"><thead><tr><th>${t("arm", "组")}</th><th>metric</th><th>% change</th><th>p</th></tr></thead><tbody>${pulseRows}</tbody></table>` : "";
		const learn = (prop?.learnings ?? []).map((l: any) => `<li><span class="badge ${l.status === "supported" ? "pass" : l.status === "refuted" ? "fail" : ""}">${esc(l.status)}</span> ${esc(l.text)}</li>`).join("");
		const c = costs[n] ?? {};
		const expLink = exp?.console_url ? `<a href="${esc(exp.console_url)}" target="_blank" rel="noopener">${esc(exp.name)}</a>` : esc(exp?.name ?? "");
		return `<details class="round" ${n === results.length - 1 || n === 0 ? "open" : ""}>
<summary><span class="rn">R${n}</span> ${esc(res.decision)} <span class="meta">${res.total_users.toLocaleString()} ${t("users", "用户")} · ${usd(c.total ?? 0)}</span></summary>
<div class="grid2">
<div><h4>${t("What the agent changed and why", "Agent 改了什么、为什么")}</h4><p class="summary">${esc(prop?.summary ?? "")}</p>${hyps ? `<ul class="hyp">${hyps}</ul>` : ""}
${rejected.length ? `<p class="muted">${t(`Validator rejected ${rejected.length} earlier attempt(s): `, `校验器退回了 ${rejected.length} 次提案：`)}${esc(rejected[0].errors.slice(0, 2).join("; "))}</p>` : ""}</div>
<div><h4>${t("Experiment", "实验")}</h4><p>${expLink} · ${esc(exp?.platform ?? "")} · ${res.arms.length} ${t("arms", "组")}</p>
${ss ? `<p class="muted">${t("Sizing", "样本量")}: ${ss.users_per_arm.toLocaleString()} ${t("users/arm", "用户/组")} (${t("base", "基线")} ${(100 * ss.base_install_per_user).toFixed(2)}% · ${t("target MDE", "目标 MDE")} ${Math.round(100 * ss.target_mde)}% · ${t("achievable", "可检测")} ${Math.round(100 * ss.achievable_mde)}%) · ${t("looks used", "已用观察次数")} ${res.looks_used}/${ss.looks}${res.stopped_early ? ` · ${t("stopped early", "提前停止")}` : ""}</p>` : ""}
<p class="muted">${t("Cost", "花费")}: ${t("strategist", "策略")} ${usd(c.llm_strategist ?? 0)} · ${t("plans", "脚本")} ${usd(c.llm_planner ?? 0)} · ${t("images", "生图")} ${usd(c.image ?? 0)} · ${t("review", "审核")} ${usd(c.vlm ?? 0)}</p></div>
</div>
${changeRows ? `<table class="t"><thead><tr><th>${t("variant", "变体")}</th><th>${t("parent", "父变体")}</th><th>${t("change vs parent", "相对父变体的改动")}</th><th>H</th><th>${t("rationale", "理由")}</th></tr></thead><tbody>${changeRows}</tbody></table>` : ""}
<h4>${t("Results", "结果")}</h4>
<div class="scroll"><table class="t res"><thead><tr><th>${t("arm", "组")}</th><th>${t("layers (changed = highlighted)", "图层（高亮=改动）")}</th><th>${t("users", "用户")}</th><th>${t("imps", "曝光")}</th><th>CTR</th><th>ipm [95% CI]</th><th>${t("lift", "提升")}</th><th>p<sub>adj</sub></th><th>P(best)</th><th>rpg / companion / casual</th><th>${t("guardrail", "护栏")}</th></tr></thead><tbody>${armRows}</tbody></table></div>
<p class="muted">${t("Segment leaders", "分人群最佳")}: ${SEGMENTS.map((s) => `${s} → <b>${esc(res.segment_winners[s])}</b>`).join(" · ")}</p>
${pulseBlock}
${videos ? `<h4>${t("Rendered videos (verified by the video model)", "已渲染视频（由视频大模型校验）")}</h4><div class="vgrid">${videos}</div>` : ""}
${learn ? `<h4>${t("Agent learnings after this round", "本轮后的 Agent 结论")}</h4><ul class="learn">${learn}</ul>` : ""}
</details>`;
	}).join("\n");

	let finalBlock = "";
	if (champ) {
		const lineage: Manifest[] = [];
		for (let cur: Manifest | undefined = champ; cur; cur = cur.parent_id ? manifests.get(cur.parent_id) : undefined) lineage.unshift(cur);
		const chain = lineage.map((m, i) => {
			const prev = lineage[i - 1];
			const d = prev ? diffLayers(prev.layers, m.layers).map((x) => `${x.layer}: ${esc(x.from)} → <b>${esc(x.to)}</b>`).join(", ") : t("seed", "种子");
			return `<li><b>${esc(m.variant_id)}</b> <small>(gen ${m.generation})</small> — ${d}</li>`;
		}).join("");
		finalBlock = `<section class="final"><h2>${t("Final creative", "最终创意")}: ${esc(champ.variant_id)}</h2>
<div class="grid2"><div class="vgrid">${videoCard(r, champ.variant_id, champ) || `<p class="muted">${t("not rendered yet", "尚未渲染")}</p>`}</div>
<div><h4>${t("Lineage", "演化路径")}</h4><ol class="lineage">${chain}</ol><h4>Manifest</h4><pre>${esc(JSON.stringify(champ, null, 2))}</pre></div></div></section>`;
	}

	const evalBlock = evalJson ? `<section><h2>${t("Offline evaluation (uses the audience model's ground truth — never shown to the agent)", "离线评估（使用受众模型的真值，Agent 看不到）")}</h2>
<table class="t"><thead><tr><th>${t("policy", "策略")}</th><th>${t("final true ipm", "最终真实 ipm")}</th><th>${t("regret vs optimum", "距最优差距")}</th><th>${t("% of optimum", "达到最优的比例")}</th></tr></thead><tbody>
${(evalJson.rows ?? []).map((x: any) => `<tr${x.policy === "agent" ? ' class="winner"' : ""}><td>${esc(x.label)}</td><td>${f2(x.final_true_ipm)}${x.sd ? ` ± ${f2(x.sd)}` : ""}</td><td>${f2(x.regret)}</td><td>${Math.round(100 * x.pct_of_optimum)}%</td></tr>`).join("")}
</tbody></table><p class="muted">${t(`Optimum in the catalog: ${esc(evalJson.optimum_label)} (true ipm ${f2(evalJson.optimum_ipm)}); round-0 control true ipm ${f2(evalJson.control_ipm)}.`, `目录内最优：${esc(evalJson.optimum_label)}（真实 ipm ${f2(evalJson.optimum_ipm)}）；第0轮对照真实 ipm ${f2(evalJson.control_ipm)}。`)}</p></section>` : "";

	const tl = trace.filter((e) => ["round_start", "proposal", "validation", "review", "verification", "variant_video_done", "experiment_created", "sample_size", "analysis", "round_end", "final", "error"].includes(e.type))
		.map((e) => `<li class="ev ${e.type}"><time>${esc(e.ts.slice(11, 19))}</time><span class="rn">R${e.round}</span><span class="ty">${esc(e.type)}</span> ${esc(e.msg)}</li>`).join("");

	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Creative Loop Trace</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#14181f;--muted:#5d6675;--line:#dde1e7;--accent:#2f5bd3;--hot:#c2410c;--hot-bg:#fff1e7;--ok:#13795b;--ok-bg:#e3f5ee;--bad:#b42318;--bad-bg:#fde8e6;--win-bg:#eef3ff}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1217;--card:#171b22;--ink:#e7eaf0;--muted:#9aa3b2;--line:#2a303a;--accent:#7ea2ff;--hot:#ff9d5c;--hot-bg:#3a2516;--ok:#4cd3a5;--ok-bg:#123128;--bad:#ff7b6e;--bad-bg:#3a1a17;--win-bg:#1b2540}}
:root[data-theme=dark]{--bg:#0f1217;--card:#171b22;--ink:#e7eaf0;--muted:#9aa3b2;--line:#2a303a;--accent:#7ea2ff;--hot:#ff9d5c;--hot-bg:#3a2516;--ok:#4cd3a5;--ok-bg:#123128;--bad:#ff7b6e;--bad-bg:#3a1a17;--win-bg:#1b2540}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans SC",sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:28px 16px 64px}header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between}
h1{font-size:24px;margin:0}h2{font-size:18px;margin:28px 0 10px}h4{margin:14px 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.muted,small{color:var(--muted)}button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:6px;padding:4px 10px;cursor:pointer}
html[lang=en] .l-zh,html[lang=zh] .l-en{display:none}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}.kpis div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column}.kpis b{font-size:20px}
.card,.round,section.final{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.round>summary{cursor:pointer;font-weight:600;list-style:none}.round>summary::-webkit-details-marker{display:none}.rn{display:inline-block;background:var(--accent);color:#fff;border-radius:4px;padding:0 6px;margin-right:6px;font-size:12px}
.meta{font-weight:400;color:var(--muted);margin-left:6px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:760px){.grid2{grid-template-columns:1fr}}
.t{width:100%;border-collapse:collapse;margin:6px 0;font-size:13px}.t th,.t td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}.t th{color:var(--muted);font-weight:600;font-size:12px}
.scroll{overflow-x:auto}.res{min-width:980px}tr.winner td{background:var(--win-bg)}tr.sum td{border-top:2px solid var(--line)}
.chip{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 5px;margin:1px 2px 1px 0;font-size:12px;white-space:nowrap}.chip.hot{background:var(--hot-bg);border-color:var(--hot);color:var(--hot);font-weight:600}
.diff{display:inline-block;margin-right:8px}.diff i{color:var(--muted);font-style:normal}.why{max-width:360px}
.badge{display:inline-block;border-radius:10px;padding:0 7px;font-size:11px;border:1px solid var(--line)}.badge.pass{background:var(--ok-bg);color:var(--ok);border-color:transparent}.badge.fail{background:var(--bad-bg);color:var(--bad);border-color:transparent}.badge.win{background:var(--accent);color:#fff;border-color:transparent}
.vgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px}.vcard{margin:0;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px}.vcard video{width:100%;aspect-ratio:9/16;background:#000;border-radius:6px}
html[lang=en] .v-zh,html[lang=zh] .v-en{display:none}.att{margin:6px 0 0;padding-left:16px;font-size:12px}.att li.pass{color:var(--ok)}.att li.fail{color:var(--bad)}
.chart{width:100%;max-width:640px;height:auto}.chart .grid{stroke:var(--line)}.chart .ax{fill:var(--muted);font-size:11px}.chart .val{fill:var(--ink);font-size:11px}.chart .win{fill:none;stroke:var(--accent);stroke-width:2.5}.chart .ctrl{fill:none;stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 4}.chart .ci{stroke:var(--accent);stroke-width:6;opacity:.25;stroke-linecap:round}.chart .dot{fill:var(--accent)}
.legend{font-size:12px;color:var(--muted)}.legend .k{display:inline-block;width:18px;height:3px;margin:0 4px 3px 10px;vertical-align:middle}.legend .k.win{background:var(--accent)}.legend .k.ctrl{border-top:2px dashed var(--muted)}
a{color:var(--accent)}pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;overflow:auto;font-size:12px}
.timeline{list-style:none;padding:0;margin:0;font-size:12.5px;max-height:420px;overflow:auto}.ev{padding:3px 0;border-bottom:1px dashed var(--line)}.ev time{color:var(--muted);margin-right:6px;font-variant-numeric:tabular-nums}.ev .ty{color:var(--muted);margin-right:6px}.ev.error{color:var(--bad)}
.summary{margin:4px 0}.hyp,.learn,.lineage{padding-left:18px;margin:4px 0}
</style></head><body><div class="wrap">
<header><div><h1>${t("Creative Loop Trace", "创意闭环追踪")} · Rune Keepers</h1><div class="muted">run <code>${esc(r.paths.id)}</code> · ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC · ${t("models", "模型")}: ${esc(r.cfg.models.strategist)} / ${esc(r.cfg.models.image)} / ${esc(r.cfg.models.verifier)}</div></div>
<div><button id="lang">中文</button> <button id="theme">◐</button></div></header>
${kpis}
<div class="grid2"><div class="card"><h4>${t("Install rate by round (ipm = installs per 1000 impressions)", "各轮安装率（ipm = 每千次曝光安装数）")}</h4>${trajectorySvg(results)}</div>
<div class="card"><h4>${t("Spend per round", "每轮花费")}</h4>${costTable}</div></div>
<h2>${t("Rounds", "各轮详情")}</h2>
${roundSections}
${finalBlock}
${evalBlock}
<section class="card"><h4>${t("Event log", "事件日志")}</h4><ul class="timeline">${tl}</ul></section>
<p class="muted">${t("Agent-written text (summaries, hypotheses, rationales) is shown in the language the agent wrote it in.", "Agent 撰写的内容（总结、假设、理由）保持其原始语言。")}</p>
</div><script>
(function(){var h=document.documentElement,b=document.getElementById('lang'),th=document.getElementById('theme');
function setL(l){h.lang=l;b.textContent=l==='en'?'中文':'EN';try{localStorage.setItem('rk-lang',l)}catch(e){}}
var saved=null;try{saved=localStorage.getItem('rk-lang')}catch(e){}setL(saved||((navigator.language||'').indexOf('zh')===0?'zh':'en'));
b.onclick=function(){setL(h.lang==='en'?'zh':'en')};
th.onclick=function(){var d=h.getAttribute('data-theme');h.setAttribute('data-theme',d==='dark'?'light':d==='light'?'':'dark')};})();
</script></body></html>`;
}

export function writeReport(r: RunContext): string {
	const html = buildReport(r);
	writeText(r.paths.html, html);
	writeText(r.paths.trajectory, buildTrajectoryMd(r));
	return r.paths.html;
}

/** Plain-text trajectory (results, hypotheses, what changed, cost) for reviewers who prefer Markdown. */
export function buildTrajectoryMd(r: RunContext): string {
	const manifests = allManifests(r.paths);
	const results = roundResults(r.paths);
	const st = loadState(r.paths);
	const costs = r.ledger.byRound();
	const out: string[] = [`# Trajectory — run ${r.paths.id}`, "", `Final champion: **${st.champion ?? "—"}** · total API spend $${r.ledger.total().toFixed(2)} · platform ${r.cfg.experiment.platform}`, ""];
	for (const res of results) {
		const prop = readJsonIf<any>(join(r.paths.round(res.round), "proposal.json"));
		out.push(`## Round ${res.round} — ${res.decision}`, "", `**Agent summary:** ${prop?.summary ?? ""}`, "");
		for (const h of prop?.hypotheses ?? []) out.push(`- ${h.id}: ${h.statement}`);
		out.push("", "| arm | change vs parent | ipm [95% CI] | lift | p_adj | P(best) |", "|---|---|---|---|---|---|");
		for (const a of res.arms) {
			const m = manifests.get(a.variant_id)!;
			const p = m.parent_id ? manifests.get(m.parent_id) : undefined;
			const ch = a.is_control ? "control" : p ? diffLayers(p.layers, m.layers).map((d) => `${d.layer}: ${d.from} → ${d.to}`).join("; ") : LAYER_NAMES.map((l) => m.layers[l]).join(" / ");
			out.push(`| ${a.variant_id}${a.variant_id === res.winner ? " 🏆" : ""} | ${ch} | ${a.ipm.toFixed(2)} [${a.ipm_ci[0].toFixed(2)}, ${a.ipm_ci[1].toFixed(2)}] | ${pct(a.lift_vs_control)} | ${a.p_adj === null ? "—" : a.p_adj.toFixed(3)} | ${a.p_best.toFixed(2)} |`);
		}
		const c = costs[res.round] ?? {};
		out.push("", `Cost: total $${(c.total ?? 0).toFixed(3)} (strategist $${(c.llm_strategist ?? 0).toFixed(3)}, plans $${(c.llm_planner ?? 0).toFixed(3)}, images $${(c.image ?? 0).toFixed(3)}, video review $${(c.vlm ?? 0).toFixed(4)})`, "");
	}
	if (existsSync(r.paths.html)) out.push(`Full interactive trace: trace.html`);
	return out.join("\n");
}
