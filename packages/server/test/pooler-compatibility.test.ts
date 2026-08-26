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
 * Statement keywords are matched case-SENSITIVELY on purpose: they are uppercase
 * throughout this codebase, and matching either case collides with ordinary
 * English in comments and agent-facing prose - "notify", "set", "declare" and
 * "lock" all appear in prose here in their hundreds. The cost is real and worth
 * naming: lowercase SQL would slip past. Function spellings (`pg_notify`,
 * `set_config`, `pg_advisory_lock`) are lowercase by convention and cannot
 * collide, so they are matched on their own terms.
 */

const SRC = join(import.meta.dirname, '../src');

/** Every `.ts` under `src`, minus generated bundles nobody hand-edits. */
function sources(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sources(path));
		else if (/\.(ts|sql)$/.test(entry.name)) out.push(path);
	}
	return out;
}

const ROOT = join(import.meta.dirname, '../..');

// The migrations are SQL rather than TypeScript and were never scanned. A
// non-LOCAL `SET` in one outlives its COMMIT and leaks to whoever the pooler
// hands that backend to next, which on a shared cluster is another tenant.
const FILES = [...sources(SRC), ...sources(join(ROOT, 'server/migrations'))]
	.filter((path) => !path.endsWith('-bundle.json'))
	.map((path) => ({ path: path.slice(ROOT.length + 1), text: readFileSync(path, 'utf8') }));

interface Rule {
	what: string;
	pattern: RegExp;
	why: string;
}

const RULES: Rule[] = [
	{
		what: 'LISTEN / NOTIFY',
		pattern: /\b(LISTEN|UNLISTEN|NOTIFY)\s+["'`$\w]|\bpg_notify\s*\(/,
		why: 'a pooler hands the next statement a different backend, so the listener never fires',
	},
	{
		what: 'session-scoped advisory lock',
		pattern: /pg_advisory_(?!xact_)lock|pg_advisory_unlock/,
		why: 'the lock belongs to a session the next statement may not be on. Use pg_advisory_xact_lock',
	},
	{
		what: 'a session-level SET',
		// Anything but SET LOCAL and SET TRANSACTION, which end with the
		// transaction. `set_config(..., false)` is the same thing spelled as a
		// function, and was missed by matching statements alone.
		// Anchored to the start of a SQL string, not merely a line: otherwise the
		// `SET` clause of every multi-line UPDATE in the codebase matches. A real
		// session SET is its own statement, so it follows a quote or a backtick.
		pattern:
			/(^|[`'";])\s*SET\s+(?!LOCAL\b|TRANSACTION\b)(ROLE|SESSION|TIMEZONE|[a-z_]+\s*(=|\bTO\b))|\bset_config\s*\(/,
		why: 'the setting lands on one backend and the next statement runs on another',
	},
	{
		what: 'a cursor',
		pattern: /\bDECLARE\s+\w+\s+(?:NO\s+SCROLL\s+)?(?:BINARY\s+)?(?:INSENSITIVE\s+)?CURSOR\b/,
		why: 'the cursor lives on the backend that declared it',
	},
	{
		what: 'a session-lifetime table lock',
		pattern: /\bLOCK\s+(TABLE\b|ONLY\b)/,
		why: 'taken outside a transaction it belongs to a session the pooler will not keep',
	},
	{
		what: 'a temporary or unlogged table',
		pattern:
			/\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?|UNLOGGED)\s+TABLE\b|\bINTO\s+TEMP(?:ORARY)?\b/,
		why: 'a temp table is per-session, so the next statement will not see it',
	},
	{
		what: 'a named prepared statement',
		pattern: /\.query\(\s*\{[^}]*\bname\s*:|\b(PREPARE|DEALLOCATE)\s+\w+/,
		why: 'the statement is prepared on one backend and executed on another',
	},
];

describe('the source tree stays usable through a transaction pooler', () => {
	it('surveys the whole of src', () => {
		expect(FILES.length).toBeGreaterThan(100);
	});

	// A rule with a typo in it passes forever, which is the exact failure this
	// file exists to prevent. Each one is fed something it MUST catch.
	it.each<[string, Rule, string]>([
		['LISTEN / NOTIFY', RULES[0], "await db.query('LISTEN Run_Updates')"],
		['LISTEN / NOTIFY', RULES[0], 'SELECT pg_notify($1, $2)'],
		['session-scoped advisory lock', RULES[1], 'SELECT pg_advisory_lock(1)'],
		['a session-level SET', RULES[2], "SET statement_timeout = '30s'"],
		['a session-level SET', RULES[2], 'SET search_path TO tenant'],
		['a session-level SET', RULES[2], "select set_config('search_path', 'x', false)"],
		['a session-level SET', RULES[2], 'SET ROLE tenant'],
		['a cursor', RULES[3], 'DECLARE c CURSOR FOR SELECT 1'],
		['a session-lifetime table lock', RULES[4], 'LOCK TABLE runs'],
		['a temporary or unlogged table', RULES[5], 'CREATE UNLOGGED TABLE scratch (id int)'],
		['a temporary or unlogged table', RULES[5], 'SELECT * INTO TEMP scratch FROM runs'],
		['a named prepared statement', RULES[6], 'PREPARE stmt AS SELECT 1'],
	])('the %s rule catches what it is for', (_what, rule, offender) => {
		expect(rule.pattern.test(offender)).toBe(true);
	});

	it.each(RULES.map((r) => [r.what, r] as const))('uses no %s', (_what, rule) => {
		const offenders = FILES.filter((f) => rule.pattern.test(f.text)).map((f) => f.path);
		expect(offenders, `${rule.what}: ${rule.why}`).toEqual([]);
	});
});
