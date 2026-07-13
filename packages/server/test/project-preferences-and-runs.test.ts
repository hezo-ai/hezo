import { DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { buildCoachReviewPrompt, type TaskInfo } from '../src/services/agent-runner';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	instanceCoachId,
	mintAgentToken,
} from './helpers/app';
import { compliantPrompt } from './helpers/prompt';

let app: Hono<Env>;
let db: Db;
let adminToken: string;
let masterKeyManager: MasterKeyManager;

let teamId: string;
let projectId: string;
let projectSlug: string;
let hqProjectId: string;
let taskId: string;

let captainId: string;
let engineerId: string;
let coachId: string;
let ceoId: string;

let captainToken: string;
let engineerToken: string;
let coachToken: string; // scoped into team A (the run-team split the Coach runs under)
let ceoToken: string; // HQ chat session, cross-project — names the target project

let teamBId: string;
let agentBId: string;

async function callToolAs(
	authToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(authToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
	return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

async function seedRun(opts: {
	team: string;
	member: string;
	task: string | null;
	log: string;
}): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs
		   (team_id, member_id, task_id, status, exit_code, invocation_command, log_text, started_at, finished_at)
		 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status, 0, 'run agent', $4, now(), now())
		 RETURNING id`,
		[opts.team, opts.member, opts.task, opts.log],
	);
	return r.rows[0].id;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(adminToken) });
	const startupId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Prefs Co', template_id: startupId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, { name: 'Prefs Project' });
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const hq = await db.query<{ id: string }>(
		`SELECT id FROM projects WHERE is_internal = true LIMIT 1`,
	);
	hqProjectId = hq.rows[0].id;

	const agents = (
		await (
			await app.request(`/api/projects/${projectSlug}/agents`, { headers: authHeader(adminToken) })
		).json()
	).data as Array<{ id: string; slug: string }>;
	captainId = agents.find((a) => a.slug === 'captain')!.id;
	engineerId = agents.find((a) => a.slug === 'engineer')!.id;

	coachId = await instanceCoachId(db);
	ceoId = await instanceCeoId(db);

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Runs Task', assignee_id: engineerId }),
	});
	taskId = (await taskRes.json()).data.id;

	({ token: captainToken } = await mintAgentToken(db, masterKeyManager, captainId, teamId, null, {
		projectId,
	}));
	({ token: engineerToken } = await mintAgentToken(db, masterKeyManager, engineerId, teamId, null, {
		projectId,
	}));
	// The Coach runs scoped into the reviewed ticket's team (run-team split).
	({ token: coachToken } = await mintAgentToken(db, masterKeyManager, coachId, teamId, null, {
		projectId,
	}));
	// The CEO chat session lives in HQ and reaches other projects by naming them.
	({ token: ceoToken } = await mintAgentToken(db, masterKeyManager, ceoId, DEFAULT_TEAM_ID, null, {
		projectId: hqProjectId,
		crossProject: true,
	}));

	// A second team, for cross-team isolation checks.
	const teamBRes = await createTestTeam(db, { name: 'Prefs Co B', template_id: startupId });
	teamBId = (await teamBRes.json()).data.id;
	const projBRes = await createTestProject(db, teamBId, { name: 'B Project' });
	const projBSlug = (await projBRes.json()).data.slug;
	const agentsB = (
		await (
			await app.request(`/api/projects/${projBSlug}/agents`, { headers: authHeader(adminToken) })
		).json()
	).data as Array<{ id: string; slug: string }>;
	agentBId = agentsB[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('project Custom Prompt tools', () => {
	it('the Captain can set it and it reaches every agent prompt', async () => {
		const body = 'TEAM RULE: always run the full test suite before pushing.';
		const applied = (await callToolAs(captainToken, 'update_project_preferences', {
			content: body,
		})) as { applied?: boolean; error?: string };
		expect(applied.error).toBeUndefined();
		expect(applied.applied).toBe(true);

		const read = (await callToolAs(captainToken, 'get_project_preferences', {})) as {
			content: string;
			length: number;
		};
		expect(read.content).toBe(body);
		expect(read.length).toBe(body.length);

		// The Custom Prompt is injected verbatim into the {{team_preferences_context}} slot.
		const prompt = (await callToolAs(adminToken, 'get_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'engineer',
		})) as { system_prompt: string };
		expect(prompt.system_prompt).toContain(body);
	});

	it('the Coach (scoped into the team) can update it', async () => {
		const res = (await callToolAs(coachToken, 'update_project_preferences', {
			content: 'Coach-added convention.',
		})) as { applied?: boolean; error?: string };
		expect(res.error).toBeUndefined();
		expect(res.applied).toBe(true);
	});

	it('the CEO (cross-team from HQ) can update it by naming the project', async () => {
		const res = (await callToolAs(ceoToken, 'update_project_preferences', {
			project: projectSlug,
			content: 'CEO-added direction.',
		})) as { applied?: boolean; error?: string };
		expect(res.error).toBeUndefined();
		expect(res.applied).toBe(true);
	});

	it('a non-privileged worker is denied', async () => {
		const res = (await callToolAs(engineerToken, 'update_project_preferences', {
			content: 'engineer should not be able to set this',
		})) as { applied?: boolean; error?: string };
		expect(res.applied).toBeUndefined();
		expect(res.error).toMatch(/Access denied/i);
	});

	it('records a restorable revision on each content change', async () => {
		await callToolAs(captainToken, 'update_project_preferences', { content: 'version one' });
		await callToolAs(captainToken, 'update_project_preferences', {
			content: 'version two',
			change_summary: 'second pass',
		});
		const revs = await db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM document_revisions dr
			 JOIN documents d ON d.id = dr.document_id
			 WHERE d.type = 'team_preferences' AND d.team_id = $1`,
			[teamId],
		);
		expect(revs.rows[0].n).toBeGreaterThanOrEqual(1);
	});
});

describe('update_agent_system_prompt authorization', () => {
	it('the CEO can now edit an agent prompt from its cross-team session', async () => {
		const res = (await callToolAs(ceoToken, 'update_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'engineer',
			new_system_prompt: compliantPrompt('You are the engineer. CEO-tuned rules.'),
			change_summary: 'coherence fix from CEO chat',
		})) as { applied?: boolean; error?: string };
		expect(res.error).toBeUndefined();
		expect(res.applied).toBe(true);
	});
});

describe('run log tools', () => {
	it('list_task_runs returns run metadata (no log text) and get_run_log returns the log', async () => {
		const log = `HEAD${'x'.repeat(20)}TAILEND`;
		const runId = await seedRun({ team: teamId, member: engineerId, task: taskId, log });

		const runs = (await callToolAs(adminToken, 'list_task_runs', {
			project: projectSlug,
			task_id: taskId,
		})) as unknown as Array<Record<string, unknown>>;
		const row = runs.find((r) => r.id === runId);
		expect(row).toBeTruthy();
		expect(row?.log_length).toBe(log.length);
		expect(row?.agent_slug).toBe('engineer');
		expect(row?.log_text).toBeUndefined(); // metadata only

		const full = (await callToolAs(adminToken, 'get_run_log', {
			project: projectSlug,
			run_id: runId,
		})) as { log: string; length: number; truncated: boolean };
		expect(full.log).toBe(log);
		expect(full.length).toBe(log.length);
		expect(full.truncated).toBe(false);
	});

	it('get_run_log returns a bounded tail when excerpt_chars is smaller than the log', async () => {
		const log = `HEAD${'x'.repeat(20)}TAILEND`;
		const runId = await seedRun({ team: teamId, member: engineerId, task: taskId, log });
		const res = (await callToolAs(adminToken, 'get_run_log', {
			project: projectSlug,
			run_id: runId,
			excerpt_chars: 7,
		})) as { log: string; length: number; truncated: boolean };
		expect(res.truncated).toBe(true);
		expect(res.length).toBe(log.length);
		expect(res.log).toBe('TAILEND'); // the last 7 chars
	});

	it('trips the result-size guard when a huge slice is requested', async () => {
		const log = 'x'.repeat(100_000);
		const runId = await seedRun({ team: teamId, member: engineerId, task: taskId, log });
		const res = (await callToolAs(adminToken, 'get_run_log', {
			project: projectSlug,
			run_id: runId,
			excerpt_chars: 100_000,
		})) as { error?: string };
		expect(res.error).toBe('result_too_large');
	});

	it('rejects a malformed run_id and a run from another team', async () => {
		const bad = (await callToolAs(adminToken, 'get_run_log', {
			project: projectSlug,
			run_id: 'not-a-uuid',
		})) as { error?: string };
		expect(bad.error).toMatch(/Invalid run_id/i);

		const foreignRun = await seedRun({ team: teamBId, member: agentBId, task: null, log: 'B log' });
		const denied = (await callToolAs(adminToken, 'get_run_log', {
			project: projectSlug,
			run_id: foreignRun,
		})) as { error?: string };
		expect(denied.error).toMatch(/not found in this project/i);
	});
});

describe('Coach review prompt', () => {
	it('injects an Agent Runs section listing the task runs', async () => {
		const runId = await seedRun({
			team: teamId,
			member: engineerId,
			task: taskId,
			log: 'coach-review run output',
		});
		const taskRow = await db.query<TaskInfo>(
			`SELECT id, identifier, title, description, status::text AS status,
			        priority::text AS priority, project_id, rules, progress_summary,
			        parent_task_id, created_by_run_id
			 FROM tasks WHERE id = $1`,
			[taskId],
		);
		const prompt = await buildCoachReviewPrompt(db, 'SYS', taskRow.rows[0], teamId);
		expect(prompt).toContain('### Agent Runs');
		expect(prompt).toContain(runId);
		expect(prompt).toMatch(/get_run_log/);
	});
});
