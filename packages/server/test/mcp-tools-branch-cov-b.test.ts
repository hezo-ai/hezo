import { ApprovalStatus, DEFAULT_TEAM_ID } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	instanceCeoId,
	mintAgentToken,
} from './helpers/app';

// Branch-coverage tests for packages/server/src/mcp/tools.ts (part B):
// hire proposals, CEO project creation / team setup, approvals resolution,
// and the agent-management tools (prompts, summaries, contexts, reporting
// lines, admin status).

let app: Hono<Env>;
let db: Db;
let token: string; // superuser admin
let masterKeyManager: MasterKeyManager;

let teamId: string;
let engineerId: string;
let qaId: string;
let captainId: string;
let ceoId: string;
let projectSlug: string;
let projectId: string;
let taskId: string;
let hqProjectSlug: string;
let apiKey: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'App Team',
	).id;

	const teamRes = await createTestTeam(db, { name: 'Branch Cov Mgmt', template_id: typeId });
	teamId = (await teamRes.json()).data.id;
	const projectRes = await createTestProject(db, teamId, { name: 'Mgmt Project' });
	const pData = (await projectRes.json()).data;
	projectId = pData.id;
	projectSlug = pData.slug;

	const agentRow = async (slug: string) =>
		(
			await db.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND ma.slug = $2`,
				[teamId, slug],
			)
		).rows[0]?.id;
	engineerId = (await agentRow('engineer')) as string;
	qaId = (await agentRow('qa-engineer')) as string;
	captainId = (await agentRow('captain')) as string;
	ceoId = await instanceCeoId(db);

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Mgmt Task', assignee_id: captainId }),
	});
	taskId = (await taskRes.json()).data.id;

	hqProjectSlug = (
		await db.query<{ slug: string }>('SELECT slug FROM projects WHERE is_internal = true LIMIT 1')
	).rows[0].slug;

	const keyRes = await app.request('/api/api-keys', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Mgmt Key' }),
	});
	apiKey = (await keyRes.json()).data.key;
});

afterAll(async () => {
	await safeClose(db);
});

async function call(
	tokenStr: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(tokenStr), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result?: { content: Array<{ text: string }> };
		error?: { message: string };
	};
	if (!body.result) return { error: body.error?.message ?? 'unknown error' };
	const text = body.result.content[0].text;
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return { error: text };
	}
}

const admin = (toolName: string, args: Record<string, unknown> = {}) => call(token, toolName, args);
const viaKey = (toolName: string, args: Record<string, unknown> = {}) =>
	call(apiKey, toolName, args);

async function agentToken(memberId: string, tId: string, tkId?: string | null): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, memberId, tId, tkId);
	return t;
}

/** A CEO run scoped into HQ but allowed to roam projects (cross-project). */
async function ceoToken(): Promise<string> {
	const { token: t } = await mintAgentToken(db, masterKeyManager, ceoId, DEFAULT_TEAM_ID, null, {
		crossProject: true,
	});
	return t;
}

describe('create_hire_proposal / update_hire_proposal', () => {
	let approvalId: string;
	let taskIdentifier: string;

	beforeAll(async () => {
		const r = await db.query<{ identifier: string }>('SELECT identifier FROM tasks WHERE id = $1', [
			taskId,
		]);
		taskIdentifier = r.rows[0].identifier;
	});

	it('captain files a proposal linked to a task', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const r = await call(at, 'create_hire_proposal', {
			heartbeat_interval_min: 720,
			title: 'Support Lead',
			role_description: 'Runs support',
			system_prompt: 'You are the Support Lead.',
			reports_to: 'captain',
			task_id: taskIdentifier,
		});
		expect(r.error).toBeUndefined();
		expect(r.approval_id).toBeDefined();
		approvalId = r.approval_id as string;

		// The proposal is surfaced on the originating ticket as an action comment.
		const comment = await db.query<{ content: Record<string, unknown> }>(
			`SELECT content FROM task_comments WHERE task_id = $1 AND content_type = 'action'::comment_content_type`,
			[taskId],
		);
		expect(comment.rows.length).toBe(1);
		expect(comment.rows[0].content.approval_id).toBe(approvalId);
	});

	it('rejects an unknown task_id', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const r = await call(at, 'create_hire_proposal', {
			heartbeat_interval_min: 720,
			title: 'Ghost Role',
			task_id: crypto.randomUUID(),
		});
		expect(r.error).toBe('task_id not found on this team');
	});

	it('update_hire_proposal rejects a self reporting line', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const r = await call(at, 'update_hire_proposal', {
			approval_id: approvalId,
			reports_to: 'support-lead',
		});
		expect(r.error).toBe('reports_to: an agent cannot report to itself');
	});

	it('update_hire_proposal rejects an unknown manager', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const r = await call(at, 'update_hire_proposal', {
			approval_id: approvalId,
			reports_to: 'nonexistent-agent',
		});
		expect(r.error).toBe("reports_to: no agent 'nonexistent-agent' in this team");
	});

	it('update_hire_proposal accepts a prompt with no substitution variables', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const r = await call(at, 'update_hire_proposal', {
			approval_id: approvalId,
			system_prompt: 'A prompt without any substitution variables.',
		});
		expect(r.error).toBeUndefined();
	});

	it('update_hire_proposal with no fields errors', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const r = await call(at, 'update_hire_proposal', { approval_id: approvalId });
		expect(r.error).toBe('no fields to update');
	});

	it('update_hire_proposal patches the payload', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const r = (await call(at, 'update_hire_proposal', {
			approval_id: approvalId,
			reports_to: 'engineer',
			monthly_budget_cents: 12300,
			touches_code: true,
		})) as { payload: Record<string, unknown> };
		expect(r.payload.reports_to).toBe('engineer');
		expect(r.payload.monthly_budget_cents).toBe(12300);
	});
});

describe('resolve_approval', () => {
	it('resolves a skill proposal (deny) and rejects double resolution', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const proposed = await call(at, 'propose_skill', {
			skill_name: 'Deploy Runbook',
			skill_slug: 'deploy-runbook',
			content: '# Deploy\n\nHow to deploy.',
			reason: 'Everyone needs it.',
		});
		const approvalId = proposed.approval_id as string;
		expect(approvalId).toBeDefined();

		// Resolve via the API key principal (authorizeTeam ApiKey branch).
		const denied = (await viaKey('resolve_approval', {
			approval_id: approvalId,
			status: ApprovalStatus.Denied,
			resolution_note: 'Not needed.',
		})) as Record<string, unknown>;
		expect(denied.status).toBe(ApprovalStatus.Denied);

		const again = await viaKey('resolve_approval', {
			approval_id: approvalId,
			status: ApprovalStatus.Approved,
		});
		expect(again.error).toBeDefined();
	});

	it('approves a skill proposal with its side effects applied', async () => {
		const at = await agentToken(engineerId, teamId, taskId);
		const proposed = await call(at, 'propose_skill', {
			skill_name: 'Release Runbook',
			skill_slug: 'release-runbook',
			content: '# Release\n\nHow to release.',
			reason: 'Everyone needs it.',
		});
		const approvalId = proposed.approval_id as string;

		const approved = (await admin('resolve_approval', {
			approval_id: approvalId,
			status: ApprovalStatus.Approved,
		})) as Record<string, unknown>;
		expect(approved.status).toBe(ApprovalStatus.Approved);

		const skill = await db.query('SELECT id FROM skills WHERE slug = $1', ['release-runbook']);
		expect(skill.rows.length).toBe(1);
	});

	it('errors on an unknown approval id', async () => {
		const r = await admin('resolve_approval', {
			approval_id: crypto.randomUUID(),
			status: ApprovalStatus.Approved,
		});
		expect(r.error).toBeDefined();
	});

	it('approving a hire proposal creates the agent (side-effect broadcast rows)', async () => {
		const at = await agentToken(captainId, teamId, taskId);
		const proposal = await call(at, 'create_hire_proposal', {
			heartbeat_interval_min: 720,
			title: 'Docs Writer',
			role_description: 'Writes docs',
			system_prompt: 'You are the Docs Writer.',
			reports_to: 'captain',
		});
		expect(proposal.approval_id).toBeDefined();

		const approved = (await admin('resolve_approval', {
			approval_id: proposal.approval_id,
			status: ApprovalStatus.Approved,
		})) as Record<string, unknown>;
		expect(approved.status).toBe(ApprovalStatus.Approved);

		const hired = await db.query(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.team_id = $1 AND ma.slug = 'docs-writer'`,
			[teamId],
		);
		expect(hired.rows.length).toBe(1);
	});
});

describe('create_project / start_team_setup (CEO)', () => {
	let newProjectSlug: string;

	it('CEO creates a project, closing an open intake task', async () => {
		// Seed an intake ticket in HQ.
		const intake = await admin('create_task', {
			project: hqProjectSlug,
			title: 'Project intake: Skunkworks',
			assignee_id: ceoId,
		});
		expect(intake.error).toBeUndefined();
		// Intake completion only fires for tickets carrying the intake label.
		await db.query(`UPDATE tasks SET labels = '["project-intake"]'::jsonb WHERE id = $1`, [
			intake.id,
		]);

		const t = await ceoToken();
		const r = await call(t, 'create_project', {
			name: 'Skunkworks',
			description: 'A brand new initiative.',
			intake_task_id: intake.id,
		});
		expect(r.error).toBeUndefined();
		expect(r.slug).toBeDefined();
		expect(r.planning_task_id).toBeDefined();
		expect(r.setup_task_id).toBeDefined();
		newProjectSlug = r.slug as string;

		// The intake ticket was completed by provisioning.
		const intakeRow = await db.query<{ status: string }>(
			'SELECT status::text AS status FROM tasks WHERE id = $1',
			[intake.id],
		);
		expect(intakeRow.rows[0].status).toBe('done');
	});

	it('rejects an unknown intake task', async () => {
		const t = await ceoToken();
		const r = await call(t, 'create_project', {
			name: 'No Intake',
			description: 'x',
			intake_task_id: crypto.randomUUID(),
		});
		expect(r.error).toBe('Intake task not found');
	});

	it('rejects an intake task that is already completed', async () => {
		const done = await admin('create_task', {
			project: hqProjectSlug,
			title: 'Closed intake',
			assignee_id: ceoId,
		});
		await admin('update_task', { project: hqProjectSlug, task_id: done.id, status: 'cancelled' });
		const t = await ceoToken();
		const r = await call(t, 'create_project', {
			name: 'Too Late',
			description: 'x',
			intake_task_id: done.id,
		});
		expect(r.error).toBe('This intake has already been completed');
	});

	it('start_team_setup assigns and wakes the CEO on the coherence task', async () => {
		const t = await ceoToken();
		const r = await call(t, 'start_team_setup', { project: newProjectSlug });
		expect(r.started).toBe(true);
		expect(r.task_id).toBeDefined();

		const row = await db.query<{ assignee_id: string }>(
			'SELECT assignee_id FROM tasks WHERE id = $1',
			[r.task_id],
		);
		expect(row.rows[0].assignee_id).toBe(ceoId);
	});

	// This guard is run-concurrency, not the reassignment guard. The CEO is both
	// the caller and the incoming assignee here, so building it on
	// `assertNoBlockingRun` would exempt itself twice over and queue a second run
	// behind the first.
	it('start_team_setup refuses while a run is active, even the CEO own run', async () => {
		const t = await ceoToken();
		const ticket = await db.query<{ id: string }>(
			`SELECT id FROM tasks
			 WHERE labels @> '["team-coherence-review"]'::jsonb
			   AND status NOT IN ('done'::task_status, 'cancelled'::task_status)
			   AND team_id = (SELECT team_id FROM projects WHERE slug = $1)
			 LIMIT 1`,
			[newProjectSlug],
		);
		const taskId = ticket.rows[0].id;
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, team_id, task_id, status, started_at)
			 SELECT $1, team_id, $2, 'running'::heartbeat_run_status, now() FROM tasks WHERE id = $2
			 RETURNING id`,
			[ceoId, taskId],
		);
		try {
			const r = await call(t, 'start_team_setup', { project: newProjectSlug });
			expect(r.error).toContain('A run is already active');
		} finally {
			await db.query('DELETE FROM heartbeat_runs WHERE id = $1', [run.rows[0].id]);
		}
	});

	it('start_team_setup errors when no open setup task exists', async () => {
		// The coherence ticket in `projectSlug`'s team was never created via the
		// CEO path; close any open one first to guarantee the error branch.
		await db.query(
			`UPDATE tasks SET status = 'cancelled'::task_status
			 WHERE team_id = $1 AND labels @> '["team-coherence-review"]'::jsonb`,
			[teamId],
		);
		const t = await ceoToken();
		const r = await call(t, 'start_team_setup', { project: projectSlug });
		expect(r.error).toBe('No open team-setup task for this project');
	});
});

describe('agent system prompts', () => {
	it('get_agent_system_prompt denies API keys', async () => {
		const r = await viaKey('get_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'engineer',
		});
		expect(r.error).toBe('Access denied');
	});

	it('get_agent_system_prompt errors on unknown agents', async () => {
		const r = await admin('get_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'nobody',
		});
		expect(r.error).toBe('Agent not found in this team');
	});

	it('get_agent_system_prompt returns raw template when placeholders=false', async () => {
		const r = (await admin('get_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'engineer',
			placeholders: false,
		})) as { system_prompt: string; slug: string };
		expect(r.slug).toBe('engineer');
		expect(r.system_prompt.length).toBeGreaterThan(0);
	});

	it('get_agent_system_prompts batches good and bad ids', async () => {
		const deniedForKey = await viaKey('get_agent_system_prompts', {
			project: projectSlug,
			items: [{ agent_id: 'engineer' }],
		});
		expect(deniedForKey.error).toBe('Access denied');

		const r = (await admin('get_agent_system_prompts', {
			project: projectSlug,
			items: [{ agent_id: 'engineer' }, { agent_id: 'nobody' }],
		})) as unknown as { items: Array<Record<string, unknown>> };
		expect(r.items).toHaveLength(2);
		expect(r.items[0].ok).toBe(true);
		expect(r.items[1].ok).toBe(false);
	});

	it('update_agent_system_prompt enforces caller and target', async () => {
		const eng = await agentToken(engineerId, teamId, taskId);
		const denied = await call(eng, 'update_agent_system_prompt', {
			agent_id: 'qa-engineer',
			new_system_prompt: 'x',
			change_summary: 'test',
		});
		expect(String(denied.error)).toContain('only the CEO, Coach, or Captain');

		const cap = await agentToken(captainId, teamId, taskId);
		const missingAgent = await call(cap, 'update_agent_system_prompt', {
			agent_id: 'nobody',
			new_system_prompt: 'x',
			change_summary: 'test',
		});
		expect(missingAgent.error).toBe('Agent not found in this team');

		// A body naming no variable is fine - the resolver composes the rest.
		const bare = (await call(cap, 'update_agent_system_prompt', {
			agent_id: 'engineer',
			new_system_prompt: 'No variables here at all.',
			change_summary: 'test',
		})) as { applied: boolean };
		expect(bare.applied).toBe(true);

		const ok = (await call(cap, 'update_agent_system_prompt', {
			agent_id: 'engineer',
			new_system_prompt: 'You are the revised Engineer.',
			change_summary: 'Rewrite for coverage.',
		})) as { applied: boolean; document_id: string };
		expect(ok.applied).toBe(true);
		expect(ok.document_id).toBeDefined();

		const raw = (await admin('get_agent_system_prompt', {
			project: projectSlug,
			agent_id: 'engineer',
			placeholders: false,
		})) as { system_prompt: string };
		expect(raw.system_prompt).toContain('You are the revised Engineer.');
	});
});

describe('agent summaries / contexts / team summary', () => {
	it('set_agent_summary denies API keys, validates the target, and writes', async () => {
		const denied = await viaKey('set_agent_summary', {
			project: projectSlug,
			agent_id: 'engineer',
			summary: 'x',
		});
		expect(denied.error).toBe('Access denied');

		const missing = await admin('set_agent_summary', {
			project: projectSlug,
			agent_id: 'nobody',
			summary: 'Handles the backend.',
		});
		expect(missing.error).toBe('Agent not found in this team');

		const r = await admin('set_agent_summary', {
			project: projectSlug,
			agent_id: 'engineer',
			summary: 'Handles the backend.',
		});
		expect(r.updated).toBe(true);
		const row = await db.query<{ summary: string }>(
			'SELECT summary FROM member_agents WHERE id = $1',
			[engineerId],
		);
		expect(row.rows[0].summary).toBe('Handles the backend.');
	});

	it('set_team_summary is captain-only and writes', async () => {
		const eng = await agentToken(engineerId, teamId, taskId);
		const denied = await call(eng, 'set_team_summary', { summary: 'not allowed' });
		expect(String(denied.error)).toContain('only the Captain');

		const cap = await agentToken(captainId, teamId, taskId);
		const r = await call(cap, 'set_team_summary', { summary: 'A crack team.' });
		expect(r.updated).toBe(true);
		const row = await db.query<{ summary: string }>('SELECT summary FROM teams WHERE id = $1', [
			teamId,
		]);
		expect(row.rows[0].summary).toBe('A crack team.');
	});

	it('set_agent_team_context and get_agent_team_context round-trip', async () => {
		const cap = await agentToken(captainId, teamId, taskId);
		const missing = await call(cap, 'set_agent_team_context', {
			agent_id: 'nobody',
			content: 'x',
		});
		expect(missing.error).toBe('Agent not found in this team');

		const set = await call(cap, 'set_agent_team_context', {
			agent_id: 'engineer',
			content: 'Owns the API layer.',
		});
		expect(set.updated).toBe(true);

		const deniedForKey = await viaKey('get_agent_team_context', {
			project: projectSlug,
			agent_id: 'engineer',
		});
		expect(deniedForKey.error).toBe('Access denied');

		const got = (await admin('get_agent_team_context', {
			project: projectSlug,
			agent_id: 'engineer',
		})) as { team_context: string };
		expect(got.team_context).toBe('Owns the API layer.');

		const gotMissing = await admin('get_agent_team_context', {
			project: projectSlug,
			agent_id: 'nobody',
		});
		expect(gotMissing.error).toBe('Agent not found in this team');
	});
});

describe('set_agent_reports_to', () => {
	it('is captain-only and validates targets', async () => {
		const eng = await agentToken(engineerId, teamId, taskId);
		const denied = await call(eng, 'set_agent_reports_to', {
			agent_id: 'qa-engineer',
			reports_to: 'captain',
		});
		expect(String(denied.error)).toContain('only the Captain or CEO');

		const cap = await agentToken(captainId, teamId, taskId);
		const fixed = await call(cap, 'set_agent_reports_to', {
			agent_id: 'captain',
			reports_to: 'engineer',
		});
		expect(String(fixed.error)).toContain('fixed and cannot be changed');

		const unknownTarget = await call(cap, 'set_agent_reports_to', {
			agent_id: 'nobody',
			reports_to: 'captain',
		});
		expect(unknownTarget.error).toBe('Agent not found in this team');

		const unknownManager = await call(cap, 'set_agent_reports_to', {
			agent_id: 'engineer',
			reports_to: 'nobody',
		});
		expect(unknownManager.error).toBe("reports_to: no agent 'nobody' in this team");

		const self = await call(cap, 'set_agent_reports_to', {
			agent_id: 'engineer',
			reports_to: 'engineer',
		});
		expect(self.error).toBe('An agent cannot report to itself');
	});

	it('applies, detects cycles, and clears reporting lines', async () => {
		const cap = await agentToken(captainId, teamId, taskId);
		const first = (await call(cap, 'set_agent_reports_to', {
			agent_id: 'qa-engineer',
			reports_to: 'engineer',
		})) as { applied: boolean; reports_to: string };
		expect(first.applied).toBe(true);
		expect(first.reports_to).toBe('engineer');

		const cycle = await call(cap, 'set_agent_reports_to', {
			agent_id: 'engineer',
			reports_to: 'qa-engineer',
		});
		expect(cycle.error).toBe('reports_to would create a reporting cycle');

		const cleared = (await call(cap, 'set_agent_reports_to', {
			agent_id: 'qa-engineer',
			reports_to: '',
		})) as { applied: boolean; reports_to: string | null };
		expect(cleared.applied).toBe(true);
		expect(cleared.reports_to).toBeNull();
		const row = await db.query<{ reports_to: string | null }>(
			'SELECT reports_to FROM member_agents WHERE id = $1',
			[qaId],
		);
		expect(row.rows[0].reports_to).toBeNull();
	});
});

describe('set_agent_status', () => {
	it('is agent-only and captain/CEO gated', async () => {
		const denied = await admin('set_agent_status', {
			project: projectSlug,
			agent: 'engineer',
			status: 'disabled',
		});
		expect(denied.error).toBe('set_agent_status is only callable by agents');

		const eng = await agentToken(engineerId, teamId, taskId);
		const notAllowed = await call(eng, 'set_agent_status', {
			agent: 'qa-engineer',
			status: 'disabled',
		});
		expect(String(notAllowed.error)).toContain('only the Captain or the CEO');
	});

	it('protects essential roles and handles unknown agents', async () => {
		const cap = await agentToken(captainId, teamId, taskId);
		const missing = await call(cap, 'set_agent_status', {
			agent: 'nobody',
			status: 'disabled',
		});
		expect(String(missing.error)).toContain('Agent not found in this team');

		const captainProtected = await call(cap, 'set_agent_status', {
			agent: 'captain',
			status: 'disabled',
		});
		expect(String(captainProtected.error)).toContain('cannot be retired with this tool');
	});

	it('disables and re-enables an agent, rejecting a no-op', async () => {
		const cap = await agentToken(captainId, teamId, taskId);
		const disabled = (await call(cap, 'set_agent_status', {
			agent: 'qa-engineer',
			status: 'disabled',
		})) as { updated: boolean; admin_status: string };
		expect(disabled.updated).toBe(true);
		expect(disabled.admin_status).toBe('disabled');

		const repeat = await call(cap, 'set_agent_status', {
			agent: 'qa-engineer',
			status: 'disabled',
		});
		expect(repeat.error).toBe('Agent is already disabled');

		const enabled = (await call(cap, 'set_agent_status', {
			agent: 'qa-engineer',
			status: 'enabled',
		})) as { updated: boolean };
		expect(enabled.updated).toBe(true);
		const row = await db.query<{ admin_status: string }>(
			'SELECT admin_status::text AS admin_status FROM member_agents WHERE id = $1',
			[qaId],
		);
		expect(row.rows[0].admin_status).toBe('enabled');
	});
});
