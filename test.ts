/**
 * Smoke test for cache-bit. Drives index.ts against a fake ExtensionAPI — no
 * network, no real pi, no provider. `bun test.ts`.
 */
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Totals } from "./index.ts";

// Force the ledger path to a temp file we control.
const tmp = mkdtempSync(join(tmpdir(), "cache-bit-test-"));
const ledgerPath = join(tmp, "token-usage.json");
process.env.PI_CACHE_BIT_LEDGER = ledgerPath;

const mod = (await import("./index.ts")) as typeof import("./index.ts");
const activate = mod.default as (pi: ExtensionAPI) => void;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
	if (cond) {
		console.log(`  ok  ${name}`);
		return;
	}
	failures++;
	console.log(`FAIL  ${name}`, detail ?? "");
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------
console.log("cacheHitRate math");

// 25% hit: 1000 cached of 4000 prompt (3000 input + 1000 cacheRead + 0 cacheWrite)
const r1 = mod.cacheHitRate({ input: 3000, cacheRead: 1000, cacheWrite: 0 } as Totals);
check("cacheRead / (input+cacheRead+cacheWrite)", r1?.rate === 25, r1);

const r2 = mod.cacheHitRate({ input: 3000, cacheRead: 3000, cacheWrite: 2000 } as Totals);
// 3000 / (3000+3000+2000) = 3000/8000 = 37.5%
check("37.5% with cacheWrite present", r2?.rate === 37.5 && r2?.promptTokens === 8000, r2);

const r3 = mod.cacheHitRate(mod.zeroTotals());
check("zero totals -> no rate", r3 === null);

const r4 = mod.cacheHitRate({ ...mod.zeroTotals(), input: 0, cacheRead: 0, cacheWrite: 5 } as Totals);
// 0 / 5 = 0%
check("cacheWrite only -> 0% hit", r4?.rate === 0 && r4?.cacheRead === 0, r4);

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
console.log("scanEntries + sumCalls");

interface AssumedUsage {
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } };
	provider?: string;
	model?: string;
	timestamp: number;
}
function assistant(role: string, usage: AssumedUsage["usage"], model?: { provider: string; model: string }): unknown {
	return {
		type: "message",
		message: {
			role,
			provider: model?.provider,
			model: model?.model,
			timestamp: 1000,
			usage,
		},
	};
}

const entries = [
	assistant("user", {} as any), // user messages have no usage counted
	assistant("assistant", { input: 3000, output: 1000, cacheRead: 3000, cacheWrite: 0, totalTokens: 7000, cost: { total: 0.07 } }, { provider: "anthropic", model: "claude-3" }),
	assistant("assistant", { input: 2000, output: 500, cacheRead: 0, cacheWrite: 2000, totalTokens: 4500, cost: { total: 0.02 } }, { provider: "anthropic", model: "claude-3" }),
	{ type: "compaction", timestamp: 2000, usage: { input: 0, output: 100, cacheRead: 50, cacheWrite: 0, totalTokens: 150, cost: { total: 0.001 } } },
	{ type: "branch_summary", timestamp: 2000, usage: { input: 0, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 40, cost: { total: 0 } } },
];

const calls = mod.scanEntries(entries as unknown[]);
check("scanEntries finds 3 calls (2 assistant + 1 compaction; branch_summary skipped)", calls.length === 3, calls.map((c) => c.ts));

const sums = mod.sumCalls(calls);
// input: 3000+2000+0 = 5000 ; cacheRead: 3000+0+50 = 3050 ; cacheWrite: 0+2000+0 = 2000
check("sumCalls input", sums.input === 5000, sums);
check("sumCalls cacheRead", sums.cacheRead === 3050, sums);
check("sumCalls cacheWrite", sums.cacheWrite === 2000, sums);
check("sumCalls requests", sums.requests === 3, sums);
const sr = mod.cacheHitRate(sums);
// 3050 / (5000+3050+2000) = 3050/10050 = 30.35%
check("session cache-hit rate", !!(sr && Math.abs(sr.rate - 30.348) < 0.01), sr);

// ---------------------------------------------------------------------------
// Ledger read
// ---------------------------------------------------------------------------
console.log("readLedger");

writeFileSync(
	ledgerPath,
	JSON.stringify({
		version: 1,
		total: { input: 100, output: 10, cacheRead: 1900, cacheWrite: 0, total: 2010, cost: 0.5, requests: 35 },
		sessions: { a: {}, b: {} },
		updatedAt: 1_000_000,
	}),
	"utf8",
);

const ledger = await mod.readLedger();
check("ledger parsed", ledger !== null);
if (ledger) {
	check("ledger total.cacheRead", ledger.total.cacheRead === 1900, ledger.total);
	check("ledger sessionCount", ledger.sessionCount === 2, ledger.sessionCount);
	check("ledger source", ledger.source === "ledger");
	const lr = mod.cacheHitRate(ledger.total);
	// 1900 / (100+1900+0) = 95.0
	check("ledger cache-hit rate", !!(lr && Math.abs(lr.rate - 95) < 0.01), lr);
}

// missing ledger -> null
process.env.PI_CACHE_BIT_LEDGER = join(tmp, "does-not-exist.json");
check("readLedger missing file -> null", (await mod.readLedger()) === null);

// ---------------------------------------------------------------------------
// Command handler (fake pi + ctx)
// ---------------------------------------------------------------------------
console.log("/cache-bit command");

// Restore the real temp ledger for the command tests.
process.env.PI_CACHE_BIT_LEDGER = ledgerPath;
writeFileSync(
	ledgerPath,
	JSON.stringify({
		version: 1,
		total: { input: 100, output: 10, cacheRead: 1900, cacheWrite: 0, total: 2010, cost: 0.5, requests: 35 },
		sessions: { a: {}, b: {} },
		updatedAt: 1_000_000,
	}),
	"utf8",
);

interface Fake {
	pi: ExtensionAPI;
	commands: Record<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>;
	entries: { type: string; data: unknown }[];
	notifications: string[];
}

function fakePi(): Fake {
	const commands: Record<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>> = {};
	const entries: { type: string; data: unknown }[] = [];
	const notifications: string[] = [];
	const pi = {
		registerCommand(name: string, options: { handler: (a: string, c: ExtensionCommandContext) => Promise<void> }): void {
			commands[name] = options.handler;
		},
		registerEntryRenderer(_type: string, _renderer: unknown): void {},
		appendEntry(customType: string, data: unknown): void {
			entries.push({ type: customType, data });
		},
	} as unknown as ExtensionAPI;
	return { pi, commands, entries, notifications };
}

const fake = fakePi();
activate(fake.pi);

const cmdNotifications: string[] = [];
const ctx = {
	mode: "tui",
	model: { provider: "anthropic", id: "claude-3" },
	sessionManager: { getEntries: () => entries },
	ui: { notify: (m: string) => { cmdNotifications.push(m); } },
} as unknown as ExtensionCommandContext;

// /cache-bit (default: both)
await fake.commands["cache-bit"]("", ctx);
const reportEntry = fake.entries[0];
check("command appends a cache-bit-report entry", reportEntry?.type === "cache-bit-report", reportEntry);

if (reportEntry) {
	const report = reportEntry.data as { title: string; lines: string[] };
	const joined = report.lines.join("\n");
	check("report title", report.title === "Cache hit rate", report.title);
	check("session line present", /cache-hit\s+\(this session\)/.test(joined), joined);
	check("global line present", /cache-hit\s+\(global, ledger\)/.test(joined), joined);
	// global 1900/(100+1900+0) = 95.0%
	check("global rate 95.0%", /95\.0% cache-hit\s+\(global/.test(joined), joined);
	check("global session count", /across 2 sessions/.test(joined), joined);
	check("notification fired", cmdNotifications.length === 1, cmdNotifications);
}

// /cache-bit session  -> omits global
const fake2 = fakePi();
activate(fake2.pi);
const ctx2 = { ...ctx, mode: "tui" } as unknown as ExtensionCommandContext;
await fake2.commands["cache-bit"]("session", ctx2);
const rep2 = (fake2.entries[0]?.data ?? null) as { lines: string[] } | null;
check("session-only omits global", !!(rep2 && !/global/.test(rep2.lines.join("\n"))), rep2?.lines);

// /cache-bit global  -> omits session
const fake3 = fakePi();
activate(fake3.pi);
await fake3.commands["cache-bit"]("global", ctx as unknown as ExtensionCommandContext);
const rep3 = (fake3.entries[0]?.data ?? null) as { lines: string[] } | null;
check("global-only omits session", !!(rep3 && !/this session/.test(rep3.lines.join("\n"))), rep3?.lines);

// print mode writes to stdout
const fake4 = fakePi();
activate(fake4.pi);
const ctx4 = { ...ctx, mode: "print" } as unknown as ExtensionCommandContext;
let stdout = "";
const origLog = console.log;
console.log = (...a: unknown[]) => { stdout += a.join(" ") + "\n"; };
await fake4.commands["cache-bit"]("", ctx4);
console.log = origLog;
check("print mode logs report", stdout.includes("Cache hit rate") && stdout.includes("global"), stdout);

console.log(failures === 0 ? "\nall scenarios passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
