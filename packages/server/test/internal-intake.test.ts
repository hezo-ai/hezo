import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	findOpenLabeledTask,
	loadCoordinationContext,
	loadTeamCoordinationContext,
} from '../src/services/internal-intake';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: PGlite;
let teamId: string;
let teamProjectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const typesRes = await ctx.app.request('/api/team-templates', { headers: authHeader(ctx.token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;
	const team = (await (await createTestTeam(db, { name: 'Intake Co', template_id: typeId })).json())
		.data;
	teamId = team.id;
	teamProjectId = (await (await createTestProject(db, teamId, { name: 'Intake Project' })).json())
		.data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('loadCoordinationContext', () => {
	it('resolves the HQ project and CEO for the instance', async () => {
		const coord = await loadCoordinationContext(db);
		expect(coord).not.toBeNull();
		expect(coord?.ceoMemberId).toBeTruthy();
		expect(coord?.hqProjectId).toBeTruthy();
		expect(coord?.hqTeamId).toBeTruthy();
	});
});

describe('loadTeamCoordinationContext', () => {
	it('resolves the CEO and the team-owned project', async () => {
		const coord = await loadTeamCoordinationContext(db, teamId);
		expect(coord).toEqual({
			ceoMemberId: expect.any(String),
			teamProjectId,
			teamId,
		});
	});

	it('returns null for a team with no non-internal project', async () => {
		expect(
			await loadTeamCoordinationContext(db, '00000000-0000-0000-0000-000000000000'),
		).toBeNull();
	});
});

describe('findOpenLabeledTask', () => {
	it('finds the open planning task by label', async () => {
		const task = await findOpenLabeledTask(db, 'planning');
		expect(task).not.toBeNull();
		expect(task?.identifier).toBeTruthy();
		expect(task?.project_slug).toBeTruthy();
	});

	it('returns null when no open task carries the label', async () => {
		expect(await findOpenLabeledTask(db, 'no-such-label-xyz')).toBeNull();
	});
});
