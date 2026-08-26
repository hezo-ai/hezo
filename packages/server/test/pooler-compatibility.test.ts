import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Hezo has to work through a transaction-mode connection pooler, because that is
 * what lets one cluster carry many instances on a fixed connection budget.
 *
 * That is a property of the whole source tree, not of any one module, and it
 * regresses silently: a `LISTEN` added years from now would work perfectly in
 * every test - on a direct connection - and strand every pooled deployment. A
 * survey done once is a snapshot; this is the guard.
 *
 * Each rule below is something a transaction pooler breaks, because it hands the
 * next statement a different backend than the last one.
 *
 * The SQL patterns are case-sensitive on purpose: keywords are written uppercase
 * throughout this codebase, and matching either case collides with ordinary
 * English in comments and agent-facing prose ("notify", "set", "declare").
 */

const SRC = join(import.meta.dirname, '../src');

/** Every `.ts` under `src`, minus generated bundles nobody hand-edits. */
function sources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sources(path));
		else if (entry.name.endsWith('.ts')) out.push(path);
	}
	return out;
}

const FILES = sources(SRC).map((path) => ({
	path: path.slice(SRC.length + 1),
	text: readFileSync(path, 'utf8'),
}));

interface Rule {
	what: string;
	pattern: RegExp;
	why: string;
}

const RULES: Rule[] = [
	{
		what: 'LISTEN / NOTIFY',
		pattern: /\b(LISTEN|UNLISTEN|NOTIFY)\s+["a-z_]/,
		why: 'a pooler hands the next statement a different backend, so the listener never fires',
	},
	{
		what: 'session-scoped advisory lock',
		pattern: /pg_advisory_(?!xact_)lock|pg_advisory_unlock/i,
		why: 'the lock belongs to a session the next statement may not be on. Use pg_advisory_xact_lock',
	},
	{
		what: 'session-level SET',
		pattern: /\b(SET\s+SESSION|SET\s+search_path|SET\s+TIME\s+ZONE)\b/,
		why: 'the setting lands on one backend and the next statement runs on another',
	},
	{
		what: 'cursor',
		pattern: /\bDECLARE\s+\w+\s+(?:NO\s+SCROLL\s+)?CURSOR\b/,
		why: 'the cursor lives on the backend that declared it',
	},
	{
		what: 'session-lifetime table lock',
		pattern: /\bLOCK\s+TABLE\b/,
		why: 'taken outside a transaction it belongs to a session the pooler will not keep',
	},
	{
		what: 'temporary table',
		pattern: /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+TABLE\b/,
		why: 'a temp table is per-session, so the next statement will not see it',
	},
	{
		what: 'named prepared statement',
		pattern: /\.query\(\s*\{[^}]*\bname\s*:/,
		why: 'the statement is prepared on one backend and executed on another',
	},
];

describe('the source tree stays usable through a transaction pooler', () => {
	it('surveys the whole of src', () => {
		expect(FILES.length).toBeGreaterThan(100);
	});

	it.each(RULES.map((r) => [r.what, r] as const))('uses no %s', (_what, rule) => {
		const offenders = FILES.filter((f) => rule.pattern.test(f.text)).map((f) => f.path);
		expect(offenders, `${rule.what}: ${rule.why}`).toEqual([]);
	});
});
