import type { PGlite } from '@electric-sql/pglite';
import { ContainerStatus, HeartbeatRunStatus } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { signAgentJwt } from '../middleware/auth';
import type { DockerClient } from './docker';
import { resolveSystemPrompt } from './template-resolver';

interface AgentInfo {
	id: string;
	title: string;
	system_prompt: string;
	company_id: string;
}

interface IssueInfo {
	id: string;
	identifier: string;
	title: string;
	description: string;
	status: string;
	priority: string;
	project_id: string;
	rules: string | null;
}

interface ProjectInfo {
	id: string;
	slug: string;
	container_id: string;
	container_status: string;
}

export interface RunResult {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	heartbeatRunId?: string;
}

export interface RunnerDeps {
	db: PGlite;
	docker: DockerClient;
	masterKeyManager: MasterKeyManager;
	serverPort: number;
	dataDir: string;
}

export async function runAgent(
	deps: RunnerDeps,
	agent: AgentInfo,
	issue: IssueInfo,
	project: ProjectInfo,
	wakeupPayload?: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<RunResult> {
	const startTime = Date.now();

	if (!project.container_id || project.container_status !== ContainerStatus.Running) {
		return {
			success: false,
			exitCode: -1,
			stdout: '',
			stderr: 'Project container is not running',
			durationMs: Date.now() - startTime,
		};
	}

	let resolvedPrompt = await resolveSystemPrompt(deps.db, agent.system_prompt, {
		companyId: agent.company_id,
		projectId: project.id,
		agentId: agent.id,
		dataDir: deps.dataDir,
	});

	if (resolvedPrompt.includes('{{requester_context}}')) {
		const creator = await deps.db.query<{ display_name: string; member_type: string }>(
			`SELECT m.display_name, m.member_type FROM issues i
			 JOIN members m ON m.id = i.created_by_member_id
			 WHERE i.id = $1`,
			[issue.id],
		);
		const row = creator.rows[0];
		const requesterText = row
			? `This task was created by ${row.display_name} (${row.member_type}).`
			: '';
		resolvedPrompt = resolvedPrompt.replace(/\{\{requester_context\}\}/g, requesterText);
	}

	const agentJwt = await signAgentJwt(deps.masterKeyManager, agent.id, agent.company_id);

	const isCoachReview = wakeupPayload?.trigger === 'issue_done';
	const taskPrompt = isCoachReview
		? await buildCoachReviewPrompt(deps.db, resolvedPrompt, issue, agent.company_id)
		: buildTaskPrompt(resolvedPrompt, issue);

	const env: string[] = [
		`HEZO_API_URL=http://host.docker.internal:${deps.serverPort}/agent-api`,
		`HEZO_AGENT_TOKEN=${agentJwt}`,
		`HEZO_AGENT_ID=${agent.id}`,
		`HEZO_COMPANY_ID=${agent.company_id}`,
		`HEZO_ISSUE_ID=${issue.id}`,
		`HEZO_ISSUE_IDENTIFIER=${issue.identifier}`,
	];

	const workingDir = '/workspace';

	const heartbeatRunId = await createHeartbeatRun(deps.db, agent, issue);

	try {
		const execId = await deps.docker.execCreate(project.container_id, {
			Cmd: ['claude', '-p', taskPrompt],
			Env: env,
			WorkingDir: workingDir,
			AttachStdout: true,
			AttachStderr: true,
		});

		const { stdout, stderr } = await deps.docker.execStart(execId, signal);
		const execInfo = await deps.docker.execInspect(execId);
		const durationMs = Date.now() - startTime;

		const success = execInfo.ExitCode === 0;

		await updateHeartbeatRun(deps.db, heartbeatRunId, {
			status: success ? HeartbeatRunStatus.Succeeded : HeartbeatRunStatus.Failed,
			exitCode: execInfo.ExitCode,
			durationMs,
			stdout: stdout.slice(0, 10000),
			stderr: stderr.slice(0, 10000),
		});

		return {
			success,
			exitCode: execInfo.ExitCode,
			stdout,
			stderr,
			durationMs,
			heartbeatRunId,
		};
	} catch (error) {
		const durationMs = Date.now() - startTime;

		await updateHeartbeatRun(deps.db, heartbeatRunId, {
			status: HeartbeatRunStatus.Failed,
			exitCode: -1,
			durationMs,
			stderr: (error as Error).message,
		});

		return {
			success: false,
			exitCode: -1,
			stdout: '',
			stderr: (error as Error).message,
			durationMs,
			heartbeatRunId,
		};
	}
}

function buildTaskPrompt(systemPrompt: string, issue: IssueInfo): string {
	const parts = [
		systemPrompt,
		'',
		'---',
		'',
		`## Current Task: ${issue.identifier} — ${issue.title}`,
		`**Priority:** ${issue.priority}`,
		`**Status:** ${issue.status}`,
		'',
	];

	if (issue.rules) {
		parts.push('### Rules for this issue');
		parts.push(issue.rules);
		parts.push('');
	}

	parts.push(issue.description || 'No description provided.');
	parts.push('');
	parts.push('Work on this task. Post comments via the Agent API to report progress.');

	return parts.join('\n');
}

async function buildCoachReviewPrompt(
	db: PGlite,
	systemPrompt: string,
	issue: IssueInfo,
	companyId: string,
): Promise<string> {
	// Fetch full comment history for the completed issue
	const comments = await db.query<{
		content_type: string;
		content: Record<string, unknown>;
		author_name: string;
		created_at: string;
	}>(
		`SELECT ic.content_type, ic.content,
		        COALESCE(ma.title, m.display_name, 'Unknown') AS author_name,
		        ic.created_at::text
		 FROM issue_comments ic
		 LEFT JOIN members m ON m.id = ic.author_member_id
		 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
		 WHERE ic.issue_id = $1
		 ORDER BY ic.created_at ASC`,
		[issue.id],
	);

	// Fetch agents involved in this issue (assignee + commenters)
	const involvedAgents = await db.query<{
		id: string;
		title: string;
		slug: string;
	}>(
		`SELECT DISTINCT ma.id, ma.title, ma.slug
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.company_id = $1
		   AND (ma.id = (SELECT assignee_id FROM issues WHERE id = $2)
		        OR ma.id IN (SELECT DISTINCT author_member_id FROM issue_comments WHERE issue_id = $2 AND author_member_id IS NOT NULL))`,
		[companyId, issue.id],
	);

	const commentLog = comments.rows
		.map((c) => {
			const text =
				c.content_type === 'text'
					? (c.content as Record<string, unknown>).text
					: JSON.stringify(c.content);
			return `[${c.created_at}] ${c.author_name} (${c.content_type}): ${text}`;
		})
		.join('\n');

	const agentList = involvedAgents.rows
		.map((a) => `- ${a.title} (slug: ${a.slug}, id: ${a.id})`)
		.join('\n');

	const parts = [
		systemPrompt,
		'',
		'---',
		'',
		`## Review Completed Ticket: ${issue.identifier} — ${issue.title}`,
		`**Final Status:** ${issue.status}`,
		`**Priority:** ${issue.priority}`,
		'',
		'### Description',
		issue.description || 'No description provided.',
		'',
		'### Agents Involved',
		agentList || 'No agents identified.',
		'',
		'### Comment History',
		commentLog || 'No comments on this issue.',
		'',
		'### Your Task',
		'Review this completed ticket. Analyze the comment history for patterns where agents struggled,',
		'received feedback, had work rejected, or needed multiple attempts. For each improvement opportunity,',
		"use the `get_agent_system_prompt` tool to read the affected agent's current prompt, then use",
		'`propose_system_prompt_update` to propose a specific rule to add to their `## Learned Rules` section.',
		'',
		'If the ticket completed smoothly without significant rework or feedback, no changes are needed.',
	];

	return parts.join('\n');
}

async function createHeartbeatRun(
	db: PGlite,
	agent: AgentInfo,
	_issue: IssueInfo,
): Promise<string> {
	const result = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, company_id, status)
		 VALUES ($1, $2, $3::heartbeat_run_status)
		 RETURNING id`,
		[agent.id, agent.company_id, HeartbeatRunStatus.Running],
	);
	return result.rows[0].id;
}

async function updateHeartbeatRun(
	db: PGlite,
	runId: string,
	update: {
		status: string;
		exitCode: number;
		durationMs: number;
		stdout?: string;
		stderr?: string;
	},
): Promise<void> {
	await db.query(
		`UPDATE heartbeat_runs
		 SET status = $1::heartbeat_run_status,
		     finished_at = now(),
		     exit_code = $2,
		     stdout_excerpt = $3,
		     stderr_excerpt = $4
		 WHERE id = $5`,
		[
			update.status,
			update.exitCode,
			update.stdout?.slice(0, 2000) ?? '',
			update.stderr?.slice(0, 2000) ?? '',
			runId,
		],
	);
}
