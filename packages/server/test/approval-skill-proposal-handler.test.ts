import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skillProposalHandler } from '../src/services/approval-handlers/skill-proposal';
import type { ApprovalSideEffectCtx } from '../src/services/approval-handlers/types';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam } from './helpers/app';

let db: PGlite;
let memberId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const typesRes = await ctx.app.request('/api/team-templates', { headers: authHeader(ctx.token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;
	const team = (await (await createTestTeam(db, { name: 'Skill Co', template_id: typeId })).json())
		.data;
	memberId = (
		await db.query<{ id: string }>('SELECT id FROM members WHERE team_id = $1 LIMIT 1', [team.id])
	).rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

function ctxFor(payload: Record<string, unknown>): ApprovalSideEffectCtx {
	return {
		db,
		approval: { requested_by_member_id: memberId },
		payload,
		resolutionNote: null,
		dataDir: '/tmp',
		actorMemberId: memberId,
	};
}

describe('skillProposalHandler.applyApproved', () => {
	it('inserts a new skill from the proposal payload', async () => {
		const out = await skillProposalHandler.applyApproved(
			ctxFor({
				skill_slug: 'deploy',
				skill_name: 'Deploy',
				reason: 'ship it',
				content: 'do the deploy',
				requested_by: memberId,
			}),
		);
		expect(out).toEqual([]);

		const row = await db.query<{ name: string; content: string; description: string }>(
			'SELECT name, content, description FROM skills WHERE slug = $1',
			['deploy'],
		);
		expect(row.rows[0]).toMatchObject({
			name: 'Deploy',
			content: 'do the deploy',
			description: 'ship it',
		});
	});

	it('updates an existing skill on conflict and records a revision', async () => {
		await skillProposalHandler.applyApproved(
			ctxFor({
				skill_slug: 'deploy',
				skill_name: 'Deploy',
				reason: 'ship it',
				content: 'updated deploy steps',
				requested_by: memberId,
			}),
		);

		const row = await db.query<{ id: string; content: string }>(
			'SELECT id, content FROM skills WHERE slug = $1',
			['deploy'],
		);
		expect(row.rows[0].content).toBe('updated deploy steps');

		const revisions = await db.query<{ c: number }>(
			'SELECT COUNT(*)::int AS c FROM skill_revisions WHERE skill_id = $1',
			[row.rows[0].id],
		);
		expect(revisions.rows[0].c).toBeGreaterThanOrEqual(1);
	});

	it('falls back to the approval requester when payload.requested_by is absent', async () => {
		const out = await skillProposalHandler.applyApproved(
			ctxFor({
				skill_slug: 'review',
				skill_name: 'Review',
				content: 'review the code',
			}),
		);
		expect(out).toEqual([]);
		const row = await db.query<{ created_by_member_id: string | null }>(
			'SELECT created_by_member_id FROM skills WHERE slug = $1',
			['review'],
		);
		expect(row.rows[0].created_by_member_id).toBe(memberId);
	});
});
