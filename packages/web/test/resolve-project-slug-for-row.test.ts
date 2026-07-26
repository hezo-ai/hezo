import { describe, expect, test } from 'vitest';
import type { Project } from '../src/hooks/use-projects';
import {
	resolveProjectSlugByIdOnly,
	resolveProjectSlugForChange,
	resolveProjectSlugForProjectRow,
	resolveProjectSlugForRow,
} from '../src/hooks/use-websocket';

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

describe('resolveProjectSlugByIdOnly', () => {
	test('resolves an ordinary project from project_id', () => {
		expect(resolveProjectSlugByIdOnly(index, { project_id: 'ops-proj' })).toBe('operations');
	});

	test('NEVER falls back to team_id — a team-wide row is unresolvable', () => {
		// This is the whole point: a heartbeat_runs/agent_wakeup_requests row carrying
		// only team_id must NOT resolve to the team's first non-internal project, or
		// every project's task list would invalidate on any project's run (the storm
		// that stalled infinite-scroll). It resolves only by its own project_id.
		expect(resolveProjectSlugByIdOnly(index, { team_id: 'ops-team' })).toBeUndefined();
		expect(
			resolveProjectSlugByIdOnly(index, { team_id: 'ops-team', task_id: 't1' }),
		).toBeUndefined();
	});

	test('resolves the run to its own project, not the team default', () => {
		// A run in ops invalidates ops; a run elsewhere on the team does not touch ops.
		expect(resolveProjectSlugByIdOnly(index, { project_id: 'ops-proj', team_id: 'hq-team' })).toBe(
			'operations',
		);
	});
});

describe('resolveProjectSlugForProjectRow', () => {
	test('resolves HQ from the row id — the team fallback never can', () => {
		// The bug this exists for: a `projects` row carries no project_id, so the
		// generic resolver fell through to team_id, which excludes is_internal
		// projects. Every HQ projects UPDATE — including container_status →
		// running, the end of provisioning — was silently dropped, leaving the
		// banner and the CEO chat stuck until a full page reload.
		expect(resolveProjectSlugForRow(index, { id: 'hq-proj', team_id: 'hq-team' })).toBeUndefined();
		expect(resolveProjectSlugForProjectRow(index, { id: 'hq-proj', team_id: 'hq-team' })).toBe(
			'hq',
		);
	});

	test('resolves an ordinary project from the row id', () => {
		expect(resolveProjectSlugForProjectRow(index, { id: 'ops-proj', team_id: 'ops-team' })).toBe(
			'operations',
		);
	});

	test('resolves a partial row carrying neither project_id nor team_id', () => {
		// The shape the startup container restart and the self-heal re-attach in
		// job-manager broadcast, plus the progress-summary and designated-repo
		// writes. These were unresolvable for ordinary projects too, not just HQ.
		expect(
			resolveProjectSlugForProjectRow(index, {
				id: 'ops-proj',
				container_status: 'running',
				container_error: null,
			}),
		).toBe('operations');
	});

	test('returns undefined for an unknown project id', () => {
		expect(resolveProjectSlugForProjectRow(index, { id: 'gone' })).toBeUndefined();
		expect(resolveProjectSlugForProjectRow(index, {})).toBeUndefined();
	});
});

describe('resolveProjectSlugForChange', () => {
	test('routes a projects row to the id-based resolver', () => {
		expect(resolveProjectSlugForChange(index, 'projects', { id: 'hq-proj' })).toBe('hq');
	});

	test('routes a strict table to the project_id-only resolver', () => {
		expect(resolveProjectSlugForChange(index, 'heartbeat_runs', { project_id: 'ops-proj' })).toBe(
			'operations',
		);
		expect(
			resolveProjectSlugForChange(index, 'heartbeat_runs', { team_id: 'ops-team' }),
		).toBeUndefined();
	});

	test('routes every other table to the project_id-then-team_id resolver', () => {
		expect(resolveProjectSlugForChange(index, 'secrets', { team_id: 'ops-team' })).toBe(
			'operations',
		);
		expect(resolveProjectSlugForChange(index, 'secrets', { project_id: 'hq-proj' })).toBe('hq');
	});

	test('a non-projects table is never resolved by its own row id', () => {
		// `id` is the row's own primary key on every other table — resolving by it
		// would map an unrelated row onto whichever project shares that uuid.
		expect(resolveProjectSlugForChange(index, 'secrets', { id: 'ops-proj' })).toBeUndefined();
	});
});
