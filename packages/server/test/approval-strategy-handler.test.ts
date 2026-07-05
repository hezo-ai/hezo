import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import { strategyHandler } from '../src/services/approval-handlers/strategy';
import type { ApprovalSideEffectCtx } from '../src/services/approval-handlers/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let db: Db;
let teamId: string;
let projectId: string;
let memberId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const typesRes = await ctx.app.request('/api/team-templates', { headers: authHeader(ctx.token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const team = (
		await (await createTestTeam(db, { name: 'Strategy Co', template_id: typeId })).json()
	).data;
	teamId = team.id;
	const project = (await (await createTestProject(db, teamId, { name: 'Strat Project' })).json())
		.data;
	projectId = project.id;
	memberId = (
		await db.query<{ id: string }>('SELECT id FROM members WHERE team_id = $1 LIMIT 1', [teamId])
	).rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

function ctxFor(payload: Record<string, unknown>): ApprovalSideEffectCtx {
	return {
		db,
		approval: { team_id: teamId, requested_by_member_id: memberId },
		payload,
		resolutionNote: null,
		dataDir: '/tmp',
		actorMemberId: memberId,
	};
}

describe('strategyHandler.applyApproved', () => {
	it('writes the PRD document and returns an UPDATE broadcast', async () => {
		const broadcasts = await strategyHandler.applyApproved(
			ctxFor({
				action: 'update_prd',
				filename: 'prd.md',
				content: '# Product Requirements\nv1',
				project_id: projectId,
			}),
		);

		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0].table).toBe('documents');
		expect(broadcasts[0].op).toBe('UPDATE');

		const doc = await db.query<{ content: string }>(
			`SELECT content FROM documents
			 WHERE type = 'project_doc' AND team_id = $1 AND project_id = $2 AND slug = $3`,
			[teamId, projectId, 'prd.md'],
		);
		expect(doc.rows[0].content).toBe('# Product Requirements\nv1');
	});

	it('is a no-op when the action is not update_prd', async () => {
		const broadcasts = await strategyHandler.applyApproved(
			ctxFor({ action: 'something_else', filename: 'x.md', content: 'y', project_id: projectId }),
		);
		expect(broadcasts).toEqual([]);
	});

	it('is a no-op when required payload fields are missing or wrong-typed', async () => {
		const broadcasts = await strategyHandler.applyApproved(
			ctxFor({ action: 'update_prd', filename: 'x.md', project_id: projectId }),
		);
		expect(broadcasts).toEqual([]);
	});
});
