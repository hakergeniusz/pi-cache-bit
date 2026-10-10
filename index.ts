/**
 * cache-bit extension — cache hit rate, globally and in this session.
 *
 * pi records raw per-call token usage on every assistant / tool-result /
 * compaction message: `{ input, output, cacheRead, cacheWrite, totalTokens, cost }`.
 * There is no single "cache hit" number pi hands out, so this extension
 * calculates it with math:
 *
 *   prompt tokens   = input + cacheRead + cacheWrite
 *   cache-hit rate  = cacheRead / promptTokens × 100
 *
 * - In this session: aggregated live from `ctx.sessionManager.getEntries()`.
 * - Globally: read from the token-usage ledger (~/.pi/agent/token-usage.json)
 *   maintained by the `pi-token-usage` extension. If that ledger is absent, run
 *   `/cache-bit --rebuild` to recount every session on disk.
 *
 * The same formula is applied to both, so the two numbers are directly
 * comparable. This measures cache-hit *rate* (tokens served from cache). For
 * cache-miss diagnostics — tokens that should have been cached but were not —
 * see pi-token-usage's cache-warming notices.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendel-works/pi-coding-agent";
import type { Theme } from "@earendel-works/pi-tui";
import { Box, Text } from "@earendel-works/pi-tui";

// @earendel-works/pi-coding-agent is provided by the host at runtime. Import it lazily so this module loads without the package being installed (keeps tests hermetic and avoids pulling the full agent graph into memory on activation).
let _agent: typeof import("@earendel-works/pi-coding-agent") | null = null;
async function agent(): Promise<typeof import("@earendel-works/pi-coding-agent")> {
	return (_agent ??= await import("@earendel-works/pi-coding-agent"));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structural subset of pi-ai `Usage` — defensive, every field optional. */
interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
}

export interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	requests: number;
}

/** A single LLM call pulled out of a session's entries. */
interface ScannedCall {
	usage: UsageLike;
	modelKey?: string;
	ts: number;
}

/** Rendered cache-hit report, attached to the transcript as a custom entry. */
interface CacheReport {
	title: string;
	lines: string[];
	timestamp: number;
}

interface LedgerStore {
	total?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
		cost?: number;
		requests?: number;
	};
	sessions?: Record<string, unknown>;
	updatedAt?: number;
}

// ---------------------------------------------------------------------------
// Totals math (mirrors pi-token-usage so the numbers stay comparable)
// ---------------------------------------------------------------------------

export function zeroTotals(): Totals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 };
}

export function totalsFromUsage(usage: UsageLike): Totals {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const total = usage.totalTokens ?? input + output;
	return {
		input,
		output,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		total,
		cost: usage.cost?.total ?? 0,
		requests: 1,
	};
}

export function addInto(dst: Totals, src: Totals): void {
	dst.input += src.input;
	dst.output += src.output;
	dst.cacheRead += src.cacheRead;
	dst.cacheWrite += src.cacheWrite;
	dst.total += src.total;
	dst.cost += src.cost;
	dst.requests += src.requests;
}

/**
 * Extract every LLM call (assistant + nested tool + compaction usage) from
 * session entries — the same selection the token-usage ledger is built from,
 * so a session tally matches the global ledger's accounting.
 */
export function scanEntries(entries: unknown[]): ScannedCall[] {
	const calls: ScannedCall[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		if (e.type === "message" && e.message) {
			const msg = e.message as Record<string, unknown>;
			if (msg.role === "assistant" && msg.usage) {
				const modelKey =
					msg.provider && msg.model ? `${msg.provider}/${msg.model}` : undefined;
				calls.push({
					usage: msg.usage as UsageLike,
					modelKey,
					ts: (msg.timestamp as number) ?? Date.now(),
				});
			} else if (msg.role === "toolResult" && msg.usage) {
				calls.push({ usage: msg.usage as UsageLike, ts: (msg.timestamp as number) ?? Date.now() });
			}
		} else if (e.type === "compaction" && e.usage) {
			const ts = e.timestamp;
			const tsMs = typeof ts === "number" ? ts : Date.parse(String(ts ?? "")) || Date.now();
			calls.push({ usage: e.usage as UsageLike, ts: tsMs });
		}
	}
	return calls;
}

export function sumCalls(calls: ScannedCall[]): Totals {
	const totals = zeroTotals();
	for (const call of calls) addInto(totals, totalsFromUsage(call.usage));
	return totals;
}

/**
 * The cache-hit rate for a set of totals.
 *
 *   promptTokens = input + cacheRead + cacheWrite
 *   rate         = cacheRead / promptTokens × 100
 *
 * `input` is never cached; `cacheRead` is the cache hit; `cacheWrite` is the
 * fresh write that primes the cache for the next turn. Returns null when there
 * is no prompt usage to score (e.g. a tool-only or uncached session).
 */
export function cacheHitRate(totals: Totals): { promptTokens: number; cacheRead: number; rate: number } | null {
	const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
	if (promptTokens <= 0) return null;
	return { promptTokens, cacheRead: totals.cacheRead, rate: (totals.cacheRead / promptTokens) * 100 };
}

// ---------------------------------------------------------------------------
// Ledger / global scan
// ---------------------------------------------------------------------------

/**
 * Path to the token-usage ledger maintained by the pi-token-usage extension.
 * Overridable via PI_CACHE_BIT_LEDGER for testing or alternate agent dirs.
 */
export async function ledgerPath(): Promise<string> {
	if (process.env.PI_CACHE_BIT_LEDGER) return process.env.PI_CACHE_BIT_LEDGER;
	return join((await agent()).getAgentDir(), "token-usage.json");
}

export interface GlobalTotals {
	total: Totals;
	sessionCount: number;
	updatedAt: number | null;
	source: "ledger" | "scan";
}

/** Read the global aggregate straight from the token-usage ledger. */
export async function readLedger(): Promise<GlobalTotals | null> {
	try {
		const raw = readFileSync(await ledgerPath(), "utf8");
		const store = JSON.parse(raw) as LedgerStore;
		const t = store.total;
		if (!t) return null;
		const input = t.input ?? 0;
		const output = t.output ?? 0;
		const cacheRead = t.cacheRead ?? 0;
		const cacheWrite = t.cacheWrite ?? 0;
		const total: Totals = {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: t.total ?? input + output + cacheRead + cacheWrite,
			cost: t.cost ?? 0,
			requests: t.requests ?? 0,
		};
		return {
			total,
			sessionCount: Object.keys(store.sessions ?? {}).length,
			updatedAt: store.updatedAt ?? null,
			source: "ledger",
		};
	} catch {
		return null;
	}
}

/** Full recount of every session on disk — the slow, dependency-free fallback. */
export async function scanGlobal(): Promise<GlobalTotals | null> {
	const total = zeroTotals();
	let sessionCount = 0;
	const { SessionManager } = await agent();
	const infos = await SessionManager.listAll();
	for (const info of infos) {
		try {
			const sm = SessionManager.open(info.path);
			const calls = scanEntries(sm.getEntries() as unknown[]);
			if (calls.length === 0) continue;
			sessionCount += 1;
			addInto(total, sumCalls(calls));
		} catch {
			// a corrupt/unreadable session is skipped, not fatal
		}
	}
	if (sessionCount === 0 && total.requests === 0) return null;
	return { total, sessionCount, updatedAt: null, source: "scan" };
}

// ---------------------------------------------------------------------------
// Formatting (matches pi-token-usage conventions)
// ---------------------------------------------------------------------------

function formatInt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function formatCost(cost: number): string {
	if (!Number.isFinite(cost)) return "$0.0000";
	return `$${cost > 0.5 ? cost.toFixed(2) : cost.toFixed(4)}`;
}

function totalsLine(t: Totals): string {
	const parts = [`↑${formatInt(t.input)} in`, `↓${formatInt(t.output)} out`];
	if (t.cacheRead > 0 || t.cacheWrite > 0) {
		parts.push(`${formatInt(t.cacheRead)} cache-read`, `${formatInt(t.cacheWrite)} cache-write`);
	}
	parts.push(`${formatInt(t.total)} total`, formatCost(t.cost), `${t.requests} req`);
	return parts.join(" · ");
}

/** `12.3% cache-hit  (3,000 cache-read of 24,200 prompt)` */
export function cacheHitLine(t: Totals): string {
	const rate = cacheHitRate(t);
	if (!rate) return "no cache usage recorded";
	return `${rate.rate.toFixed(1)}% cache-hit  (${formatInt(rate.cacheRead)} cache-read of ${formatInt(rate.promptTokens)} prompt tokens)`;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface ReportOpts {
	sessionOnly: boolean;
	globalOnly: boolean;
	rebuild: boolean;
}

function modelKeyOf(model: ExtensionCommandContext["model"]): string | undefined {
	if (model && model.provider && model.id) return `${model.provider}/${model.id}`;
	return undefined;
}

async function buildReport(ctx: ExtensionCommandContext, opts: ReportOpts): Promise<CacheReport> {
	const lines: string[] = [];
	const title = "Cache hit rate";

	// ----- in this session (live) -----
	const sessionTotals = sumCalls(scanEntries(ctx.sessionManager.getEntries() as unknown[]));
	const sessionRate = cacheHitRate(sessionTotals);
	const modelKey = modelKeyOf(ctx.model);

	if (!opts.globalOnly) {
		if (sessionRate) {
			lines.push(`${sessionRate.rate.toFixed(1)}% cache-hit  (this session)`);
			lines.push(`  ${cacheHitLine(sessionTotals)}`);
			lines.push(`  ${totalsLine(sessionTotals)}${modelKey ? ` · ${modelKey}` : ""}`);
		} else {
			lines.push("this session: no cache usage recorded");
		}
	}

	// ----- global -----
	if (!opts.sessionOnly) {
		const g: GlobalTotals | null = opts.rebuild ? await scanGlobal() : await readLedger();
		if (g) {
			const rate = cacheHitRate(g.total);
			const src = g.source === "ledger" ? "ledger" : "recount";
			if (rate) {
				lines.push(`${rate.rate.toFixed(1)}% cache-hit  (global, ${src})`);
				lines.push(`  ${formatInt(rate.cacheRead)} cache-read of ${formatInt(rate.promptTokens)} prompt tokens`);
				lines.push(`  across ${g.sessionCount.toLocaleString("en-US")} sessions`);
				if (g.source === "ledger" && g.updatedAt) {
					lines.push(`  ledger updated ${new Date(g.updatedAt).toLocaleString()}`);
				}
			} else {
				lines.push(`global (${src}): no cache usage recorded`);
			}
		} else if (opts.rebuild) {
			lines.push("global: recount scanned every session — none had usage");
		} else {
			lines.push(
				`global: ledger not found at ${(await ledgerPath())} — install \`pi-token-usage\`, or run \`/cache-bit --rebuild\` to scan sessions on disk`,
			);
		}
	}

	return { title, lines, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// UI: persist the report to the transcript (TUI/RPC) + stdout (print mode)
// ---------------------------------------------------------------------------

function showReport(pi: ExtensionAPI, ctx: ExtensionCommandContext, report: CacheReport): void {
	pi.appendEntry<CacheReport>("cache-bit-report", report);
	if (ctx.mode === "print") {
		console.log(`\n${report.title}\n${report.lines.map((l) => `  ${l}`).join("\n")}\n`);
	} else {
		ctx.ui.notify(`${report.lines[0] ?? report.title}`, "info");
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function cacheBit(pi: ExtensionAPI) {
	pi.registerEntryRenderer<CacheReport>("cache-bit-report", (entry, { expanded }, theme: Theme) => {
		const data = entry.data ?? { title: "Cache hit rate", lines: [], timestamp: 0 };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", "◈")} ${theme.bold(data.title)}`, 0, 0));
		for (const line of data.lines) {
			box.addChild(new Text(`  ${theme.fg("muted", line)}`, 0, 0));
		}
		if (expanded) {
			box.addChild(
				new Text(theme.fg("dim", `  updated ${new Date(data.timestamp).toLocaleString()}`), 0, 0),
			);
		}
		return box;
	});

	pi.registerCommand("cache-bit", {
		description: "Show cache hit rate: globally (calculated with math) and in this session",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["session", "global", "--rebuild"];
			const filtered = subs.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const rebuild = tokens.includes("--rebuild") || tokens.includes("rebuild");
			const sessionOnly = tokens.includes("session");
			const globalOnly = tokens.includes("global");

			const report = await buildReport(ctx, { sessionOnly, globalOnly, rebuild });
			showReport(pi, ctx, report);
		},
	});
}
