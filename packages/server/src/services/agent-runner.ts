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
}

export async function runAgent(
	deps: RunnerDeps,
	agent: AgentInfo,
	issue: IssueInfo,
	project: ProjectInfo,
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

	const resolvedPrompt = await resolveSystemPrompt(deps.db, agent.system_prompt, {
		companyId: agent.company_id,
		projectId: project.id,
	});

	const agentJwt = await signAgentJwt(deps.masterKeyManager, agent.id, agent.company_id);

	const taskPrompt = buildTaskPrompt(resolvedPrompt, issue);

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

		const { stdout, stderr } = await deps.docker.execStart(execId);
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
	return [
		systemPrompt,
		'',
		'---',
		'',
		`## Current Task: ${issue.identifier} — ${issue.title}`,
		`**Priority:** ${issue.priority}`,
		`**Status:** ${issue.status}`,
		'',
		issue.description || 'No description provided.',
		'',
		'Work on this task. Post comments via the Agent API to report progress.',
	].join('\n');
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
