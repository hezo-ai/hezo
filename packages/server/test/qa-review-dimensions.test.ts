import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard: the App Team's QA Engineer names the dimensions its code review covers,
 * and names them exactly once.
 *
 * The mechanism — fan the review out to adversarial sub-agents, one per
 * dimension, then reconcile — lives in SHARED_INSTRUCTIONS, because reviewing a
 * teammate's work reaches every role that does it and every future hire. That
 * rule asks each role for one thing back: its own dimension list. This file is
 * the QA half of that contract, and `template-resolver.test.ts` is the shared
 * half.
 *
 * "Once" is the load-bearing word. The list previously existed twice — four
 * dimensions inline in the post-implementation review, nine more in a Proactive
 * audits table — which is how the two drifted apart. Both consumers now point at
 * the one table.
 *
 * We assert against the role-doc source (not the built bundle) so the guard
 * reads the current source of truth regardless of bundle freshness. If you
 * intentionally reword or rename a dimension, update these substrings — but keep
 * the concept, and keep the list singular.
 */
const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'agents');

async function readRoleDoc(relPath: string): Promise<string> {
	return (await readFile(join(AGENTS_DIR, relPath), 'utf-8')).toLowerCase();
}

/** The lenses a QA code review runs, one sub-agent each. */
const DIMENSIONS = [
	'correctness',
	'security',
	'performance',
	'scalability',
	'maintainability',
	'architectural elegance',
	'testing',
	'documentation',
];

/** Labels the rename replaced. A half-applied rename leaves one of these behind. */
const RETIRED_LABELS = ['scale and resource use', 'design patterns', 'test coverage'];

describe('App Team QA Engineer names its review dimensions', () => {
	it('declares the dimension list as its own section', async () => {
		const text = await readRoleDoc('app-dev/qa-engineer.md');

		expect(text).toContain('## review dimensions');
		expect(text).toContain('every code review covers these eight dimensions');
	});

	it.each(DIMENSIONS)('covers the %s dimension', async (dimension) => {
		const text = await readRoleDoc('app-dev/qa-engineer.md');

		expect(text).toContain(`| ${dimension} |`);
	});

	it.each(RETIRED_LABELS)('no longer carries the retired "%s" label', async (label) => {
		const text = await readRoleDoc('app-dev/qa-engineer.md');

		expect(text).not.toContain(`| ${label} |`);
	});

	it('states the list once, not once per consumer', async () => {
		const text = await readRoleDoc('app-dev/qa-engineer.md');

		// A second table anywhere in the file — a re-added Proactive audits copy is
		// the likely one — shows up as a second Correctness row.
		expect(text.split('| correctness |')).toHaveLength(2);
	});

	it('points both the code review and the heartbeat audit at that one list', async () => {
		const text = await readRoleDoc('app-dev/qa-engineer.md');

		// Post-implementation review step 4, and the Proactive audits lead line.
		expect(text.split('review dimensions above').length - 1).toBe(2);
	});
});
