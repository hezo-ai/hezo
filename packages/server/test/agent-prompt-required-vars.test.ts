import { LIVE_CONTEXT_BLOCK_VARS } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { loadAgentRoles } from '../src/db/agent-roles';

/**
 * The inverse of the guard this file used to hold. Nothing requires a
 * substitution variable any more: the resolver composes an identity block above
 * the authored body and a live-context block below it. A shipped role doc that
 * still places those values itself would suppress the composed block for that
 * value, so the doc - not the resolver - would silently own it again.
 *
 * Scoped to the live-context manifests only. Placing an identity token inline
 * is the supported way for a prompt to write its own opening line - the Coach
 * does exactly that, because its team varies per run - and skipping the
 * composed identity block is then the intended effect, not a leak.
 */
describe('shipped role docs leave the live-context block to the resolver', () => {
	it('no role doc places a manifest the resolver composes', async () => {
		const roles = await loadAgentRoles();
		const paths = Object.keys(roles);
		expect(paths.length).toBeGreaterThan(0);

		const offenders = Object.entries(roles)
			.map(([path, content]) => ({
				path,
				placed: LIVE_CONTEXT_BLOCK_VARS.filter((token) => content.includes(token)),
			}))
			.filter((r) => r.placed.length > 0);

		expect(
			offenders,
			`These role docs still place a live-context manifest themselves: ${JSON.stringify(offenders)}`,
		).toEqual([]);
	});

	it('no role doc carries a retired token', async () => {
		const roles = await loadAgentRoles();
		const retired = [
			'{{team_context}}',
			'{{team_description}}',
			'{{required_prompt_vars}}',
			'{{requester_context}}',
			'{{kb_context}}',
		];
		const offenders = Object.entries(roles)
			.map(([path, content]) => ({
				path,
				retired: retired.filter((token) => content.includes(token)),
			}))
			.filter((r) => r.retired.length > 0);

		expect(
			offenders,
			`These role docs carry a retired token: ${JSON.stringify(offenders)}`,
		).toEqual([]);
	});
});
