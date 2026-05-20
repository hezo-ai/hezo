import type { PGlite } from '@electric-sql/pglite';
import { ApprovalStatus, ApprovalType, IssueStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import {
	buildTeamTemplateApprovedAckText,
	CAPTAIN_HIRE_TEAM_GREETING,
	HIRE_TEAM_INTAKE_LABEL,
	HIRE_TEAM_INTAKE_TITLE,
} from '../../services/hire-team-intake';
import { REQUIREMENTS_INTAKE_TITLE } from '../../services/requirements-intake';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
});

beforeEach(async () => {
	await db.query('DELETE FROM teams');
});

afterAll(async () => {
	await safeClose(db);
});

describe('hire-team intake', () => {
	it('creates hire-the-team issue when requirements intake is marked done', async () => {
		const blank = await db.query<{ id: string }>(
			"SELECT id FROM team_templates WHERE name = 'Blank' LIMIT 1",
		);
		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Hire Flow Co', template_id: blank.rows[0].id }),
		});
		const team = (await teamRes.json()).data as { id: string; slug: string };

		const intakeRes = await app.request(`/api/teams/${team.slug}/requirements-intake`, {
			headers: authHeader(token),
		});
		const intake = (await intakeRes.json()).data as { issue_id: string };

		const doneRes = await app.request(`/api/teams/${team.slug}/issues/${intake.issue_id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Done }),
		});
		expect(doneRes.status).toBe(200);

		const hireRes = await app.request(`/api/teams/${team.slug}/hire-team-intake`, {
			headers: authHeader(token),
		});
		expect(hireRes.status).toBe(200);
		const hire = (await hireRes.json()).data as {
			issue_identifier: string;
			captain_greeting: string;
		};
		expect(hire.captain_greeting).toBe(CAPTAIN_HIRE_TEAM_GREETING);
		expect(hire.issue_identifier).toMatch(/^OP-\d+$/);

		const issuesRes = await app.request(`/api/teams/${team.slug}/issues`, {
			headers: authHeader(token),
		});
		const issues = (await issuesRes.json()).data as Array<{ title: string; labels: string[] }>;
		const hireIssue = issues.find((i) => i.title === HIRE_TEAM_INTAKE_TITLE);
		expect(hireIssue?.labels).toContain(HIRE_TEAM_INTAKE_LABEL);
		expect(issues.some((i) => i.title === REQUIREMENTS_INTAKE_TITLE)).toBe(true);
	});

	it('provisions template agents when board approves team_template approval', async () => {
		const blank = await db.query<{ id: string }>(
			"SELECT id FROM team_templates WHERE name = 'Blank' LIMIT 1",
		);
		const startup = await db.query<{ id: string }>(
			"SELECT id FROM team_templates WHERE name = 'Startup' LIMIT 1",
		);
		const teamRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Provision Co', template_id: blank.rows[0].id }),
		});
		const team = (await teamRes.json()).data as { id: string; slug: string };

		const intakeRes = await app.request(`/api/teams/${team.slug}/requirements-intake`, {
			headers: authHeader(token),
		});
		const intake = (await intakeRes.json()).data as { issue_id: string };
		await app.request(`/api/teams/${team.slug}/issues/${intake.issue_id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Done }),
		});

		const hireRes = await app.request(`/api/teams/${team.slug}/hire-team-intake`, {
			headers: authHeader(token),
		});
		expect(hireRes.status).toBe(200);
		const hire = (await hireRes.json()).data as { issue_id: string };

		const agentsBefore = await app.request(`/api/teams/${team.slug}/agents`, {
			headers: authHeader(token),
		});
		const countBefore = ((await agentsBefore.json()).data as unknown[]).length;

		const approvalInsert = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, payload, status)
			 VALUES ($1, $2::approval_type, $3::jsonb, $4::approval_status)
			 RETURNING id`,
			[
				team.id,
				ApprovalType.TeamTemplate,
				JSON.stringify({
					template_id: startup.rows[0].id,
					template_name: 'Startup',
					rationale: 'Software project',
					issue_id: hire.issue_id,
				}),
				ApprovalStatus.Pending,
			],
		);
		const approvalId = approvalInsert.rows[0].id;

		const resolveRes = await app.request(`/api/approvals/${approvalId}/resolve`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: ApprovalStatus.Approved }),
		});
		expect(resolveRes.status).toBe(200);

		const agentsAfter = await app.request(`/api/teams/${team.slug}/agents`, {
			headers: authHeader(token),
		});
		const countAfter = ((await agentsAfter.json()).data as unknown[]).length;
		expect(countAfter).toBeGreaterThan(countBefore);

		const commentsRes = await app.request(
			`/api/teams/${team.slug}/issues/${hire.issue_id}/comments`,
			{ headers: authHeader(token) },
		);
		const comments = (await commentsRes.json()).data as Array<{
			content: { text: string };
			author_name: string;
		}>;
		const ack = comments.find((c) =>
			c.content.text.includes(buildTeamTemplateApprovedAckText('Startup').slice(0, 40)),
		);
		expect(ack).toBeDefined();
		expect(ack?.author_name).toBe('Captain');
		expect(ack?.content.text).toContain('setting up the team');

		const complete = comments.find((c) => c.content.text.includes('Team setup is complete'));
		expect(complete?.author_name).toBe('Captain');
		expect(complete?.content.text).toContain('Start project');

		const hireIssueRes = await app.request(`/api/teams/${team.slug}/issues/${hire.issue_id}`, {
			headers: authHeader(token),
		});
		const hireIssue = (await hireIssueRes.json()).data as { status: string };
		expect(hireIssue.status).toBe(IssueStatus.Done);

		const hireIntakeAfter = await app.request(`/api/teams/${team.slug}/hire-team-intake`, {
			headers: authHeader(token),
		});
		expect(hireIntakeAfter.status).toBe(404);

		const onboardingRes = await app.request(`/api/teams/${team.slug}/onboarding`, {
			headers: authHeader(token),
		});
		const onboarding = (await onboardingRes.json()).data as { current_stage: string };
		expect(onboarding.current_stage).toBe('start_project');
	});
});
