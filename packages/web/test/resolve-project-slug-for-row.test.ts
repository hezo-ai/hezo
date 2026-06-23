import { describe, expect, test } from 'vitest';
import type { Project } from '../src/hooks/use-projects';
import { resolveProjectSlugForRow } from '../src/hooks/use-websocket';

// resolveProjectSlugForRow only reads id/slug/team_id/is_internal; cast minimal
// fixtures rather than spelling out every Project field.
function project(p: { id: string; slug: string; team_id: string; is_internal?: boolean }): Project {
	return p as unknown as Project;
}

const HQ = project({ id: 'hq-proj', slug: 'hq', team_id: 'hq-team', is_internal: true });
const OPS = project({
	id: 'ops-proj',
	slug: 'operations',
	team_id: 'ops-team',
	is_internal: false,
});
const index = [HQ, OPS];

describe('resolveProjectSlugForRow', () => {
	test('resolves an ordinary project from project_id', () => {
		expect(resolveProjectSlugForRow(index, { project_id: 'ops-proj' })).toBe('operations');
	});

	test('resolves the internal HQ project from project_id — team_id cannot', () => {
		// HQ is is_internal: the team fallback excludes internal projects, so a
		// comment-family row keyed only by team_id would never resolve for HQ-1.
		// project_id is the field that makes the realtime fix work for HQ.
		expect(resolveProjectSlugForRow(index, { project_id: 'hq-proj' })).toBe('hq');
		expect(resolveProjectSlugForRow(index, { team_id: 'hq-team' })).toBeUndefined();
	});

	test('falls back to team_id for a non-internal team-wide row', () => {
		expect(resolveProjectSlugForRow(index, { team_id: 'ops-team' })).toBe('operations');
	});

	test('prefers project_id over team_id', () => {
		expect(resolveProjectSlugForRow(index, { project_id: 'ops-proj', team_id: 'hq-team' })).toBe(
			'operations',
		);
	});

	test('returns undefined for a bare row with neither id', () => {
		// A pre-fix comment-family row (only task_id) is unresolvable — exactly why
		// the broadcast must inject project_id.
		expect(resolveProjectSlugForRow(index, { task_id: 't1' })).toBeUndefined();
	});
});
