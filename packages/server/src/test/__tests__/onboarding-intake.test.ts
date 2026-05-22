import type { PGlite } from '@electric-sql/pglite';
import { IssueStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import {
	CAPTAIN_GREETING_TEXT,
	ONBOARDING_INTAKE_LABEL,
	ONBOARDING_INTAKE_TITLE,
} from '../../services/onboarding-intake';
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

describe('onboarding intake', () => {
	it('creates an Operations issue with Captain greeting on demand', async () => {
		const blank = await db.query<{ id: string }>(
			"SELECT id FROM team_templates WHERE name = 'Blank' LIMIT 1",
		);
		expect(blank.rows.length).toBe(1);

		const res = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Intake Test Co', template_id: blank.rows[0].id }),
		});
		expect(res.status).toBe(201);
		const team = (await res.json()).data as { slug: string };

		const intakeRes = await app.request(`/api/teams/${team.slug}/onboarding-intake?ensure=true`, {
			headers: authHeader(token),
		});
		expect(intakeRes.status).toBe(200);
		const intake = (await intakeRes.json()).data as {
			issue_identifier: string;
			project_slug: string;
			captain_greeting: string;
		};
		expect(intake.project_slug).toBe('operations');
		expect(intake.captain_greeting).toBe(CAPTAIN_GREETING_TEXT);
		expect(intake.issue_identifier).toMatch(/^OP-\d+$/);

		const issuesRes = await app.request(`/api/teams/${team.slug}/issues`, {
			headers: authHeader(token),
		});
		const issues = (await issuesRes.json()).data as Array<{
			title: string;
			labels: string[];
			assignee_name: string;
		}>;
		const intakeIssue = issues.find((i) => i.title === ONBOARDING_INTAKE_TITLE);
		expect(intakeIssue).toBeDefined();
		expect(intakeIssue?.labels).toContain(ONBOARDING_INTAKE_LABEL);
		expect(intakeIssue?.assignee_name).toBe('Captain');

		const commentsRes = await app.request(
			`/api/teams/${team.slug}/issues/${intake.issue_identifier}/comments`,
			{ headers: authHeader(token) },
		);
		const comments = (await commentsRes.json()).data as Array<{
			author_name: string;
			content: { text: string };
		}>;
		expect(
			comments.some((c) => c.author_name === 'Captain' && c.content.text === CAPTAIN_GREETING_TEXT),
		).toBe(true);
	});

	it('does not create duplicate intake issues', async () => {
		const blank = await db.query<{ id: string }>(
			"SELECT id FROM team_templates WHERE name = 'Blank' LIMIT 1",
		);
		const createRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Dedup Intake Co', template_id: blank.rows[0].id }),
		});
		const team = (await createRes.json()).data as { slug: string };

		const first = await app.request(`/api/teams/${team.slug}/onboarding-intake?ensure=true`, {
			headers: authHeader(token),
		});
		const second = await app.request(`/api/teams/${team.slug}/onboarding-intake?ensure=true`, {
			headers: authHeader(token),
		});
		const a = (await first.json()).data as { issue_id: string };
		const b = (await second.json()).data as { issue_id: string };
		expect(a.issue_id).toBe(b.issue_id);

		const count = await db.query<{ count: number }>(
			`SELECT count(*)::int AS count FROM issues
			 WHERE team_id = (SELECT id FROM teams WHERE slug = $1)
			   AND labels @> $2::jsonb`,
			[team.slug, JSON.stringify([ONBOARDING_INTAKE_LABEL])],
		);
		expect(count.rows[0].count).toBe(1);
	});

	it('returns 404 without ensure when the onboarding ticket is closed', async () => {
		const blank = await db.query<{ id: string }>(
			"SELECT id FROM team_templates WHERE name = 'Blank' LIMIT 1",
		);
		const createRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Closed Intake Co', template_id: blank.rows[0].id }),
		});
		const team = (await createRes.json()).data as { slug: string };

		const openRes = await app.request(`/api/teams/${team.slug}/onboarding-intake?ensure=true`, {
			headers: authHeader(token),
		});
		const open = (await openRes.json()).data as { issue_id: string };
		expect(openRes.status).toBe(200);

		await db.query(`UPDATE issues SET status = $1::issue_status WHERE id = $2`, [
			IssueStatus.Done,
			open.issue_id,
		]);

		const closedRes = await app.request(`/api/teams/${team.slug}/onboarding-intake`, {
			headers: authHeader(token),
		});
		expect(closedRes.status).toBe(404);

		const ensureRes = await app.request(`/api/teams/${team.slug}/onboarding-intake?ensure=true`, {
			headers: authHeader(token),
		});
		expect(ensureRes.status).toBe(200);
	});

	it('posts a system comment and wakes Captain on skip-questions', async () => {
		const blank = await db.query<{ id: string }>(
			"SELECT id FROM team_templates WHERE name = 'Blank' LIMIT 1",
		);
		const createRes = await app.request('/api/teams', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Skip Q Co', template_id: blank.rows[0].id }),
		});
		const team = (await createRes.json()).data as { slug: string };

		const ensureRes = await app.request(`/api/teams/${team.slug}/onboarding-intake?ensure=true`, {
			headers: authHeader(token),
		});
		const intake = (await ensureRes.json()).data as { issue_id: string; issue_identifier: string };

		const skipRes = await app.request(`/api/teams/${team.slug}/onboarding-intake/skip-questions`, {
			method: 'POST',
			headers: authHeader(token),
		});
		expect(skipRes.status).toBe(200);

		const commentsRes = await app.request(
			`/api/teams/${team.slug}/issues/${intake.issue_identifier}/comments`,
			{ headers: authHeader(token) },
		);
		const comments = (await commentsRes.json()).data as Array<{
			content_type: string;
			content: { text: string };
		}>;
		const systemComment = comments.find(
			(c) => c.content_type === 'system' && c.content.text.toLowerCase().includes('skip'),
		);
		expect(systemComment).toBeDefined();
	});
});
