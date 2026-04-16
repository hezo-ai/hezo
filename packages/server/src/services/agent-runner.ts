import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
	type AgentRuntime,
	ContainerStatus,
	HeartbeatRunStatus,
	PROVIDER_TO_ENV_VAR,
	RUNTIME_COMMANDS,
	RUNTIME_TO_PROVIDER,
	WsMessageType,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { signAgentJwt } from '../middleware/auth';
import { getProviderCredential } from './ai-provider-keys';
import type { DockerClient, ExecLogChunk } from './docker';
import { applyEffortToRuntime, resolveEffort } from './effort';
import { ensureIssueWorktree, fetchRepo } from './git';
import { ensureProjectRepos } from './repo-sync';
import { getCompanySSHKey } from './ssh-keys';
import { resolveSystemPrompt } from './template-resolver';
import { getWorkspacePath, getWorktreesPath } from './workspace';
import type { WebSocketManager } from './ws';

const LOG_CAP_BYTES = 1_000_000;

interface AgentInfo {
	id: string;
	title: string;
	system_prompt: string;
	company_id: string;
	runtime_type: AgentRuntime;
	default_effort?: string | null;
}

export interface IssueInfo {
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
	company_id: string;
	company_slug: string;
	container_id: string;
	container_status: string;
	designated_repo_id: string | null;
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
	wsManager?: WebSocketManager;
}

interface RepoRow {
	id: string;
	short_name: string;
	repo_identifier: string;
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

	if (signal?.aborted) return abortedResult(startTime);

	let resolvedPrompt = await resolveSystemPrompt(deps.db, agent.system_prompt, {
		companyId: agent.company_id,
		projectId: project.id,
		agentId: agent.id,
		dataDir: deps.dataDir,
	});

	if (signal?.aborted) return abortedResult(startTime);

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

	if (signal?.aborted) return abortedResult(startTime);

	const agentJwt = await signAgentJwt(deps.masterKeyManager, agent.id, agent.company_id);

	const effort = resolveEffort(wakeupPayload?.effort, agent.default_effort);
	const effortApplication = applyEffortToRuntime(agent.runtime_type, effort);

	const isCoachReview = wakeupPayload?.trigger === 'issue_done';
	const basePrompt = isCoachReview
		? await buildCoachReviewPrompt(deps.db, resolvedPrompt, issue, agent.company_id)
		: buildTaskPrompt(resolvedPrompt, issue, wakeupPayload);
	const taskPrompt = effortApplication.promptDirective
		? `${basePrompt}\n\n${effortApplication.promptDirective}`
		: basePrompt;

	const env: string[] = [
		`HEZO_API_URL=http://host.docker.internal:${deps.serverPort}/agent-api`,
		`HEZO_AGENT_TOKEN=${agentJwt}`,
		`HEZO_AGENT_ID=${agent.id}`,
		`HEZO_COMPANY_ID=${agent.company_id}`,
		`HEZO_ISSUE_ID=${issue.id}`,
		`HEZO_ISSUE_IDENTIFIER=${issue.identifier}`,
		`HEZO_AGENT_EFFORT=${effort}`,
		...effortApplication.extraEnv,
	];

	const allEnvVars = new Set<string>();
	for (const methods of Object.values(PROVIDER_TO_ENV_VAR)) {
		for (const envVar of Object.values(methods)) {
			allEnvVars.add(envVar);
		}
	}
	for (const envVar of allEnvVars) {
		env.push(`${envVar}=`);
	}

	const runtimeType = agent.runtime_type;
	const provider = RUNTIME_TO_PROVIDER[runtimeType];
	const credential = await getProviderCredential(deps.db, deps.masterKeyManager, provider);

	if (!credential) {
		return {
			success: false,
			exitCode: -1,
			stdout: '',
			stderr: `No ${provider} credential configured. Add one in Settings > AI Providers.`,
			durationMs: Date.now() - startTime,
		};
	}

	const envVarName = PROVIDER_TO_ENV_VAR[provider]?.[credential.authMethod];
	if (envVarName) {
		const idx = env.findIndex((e) => e.startsWith(`${envVarName}=`));
		if (idx >= 0) env[idx] = `${envVarName}=${credential.value}`;
	}

	const cliCommand = RUNTIME_COMMANDS[runtimeType] || 'claude';

	const heartbeatRunId = await createHeartbeatRun(deps.db, agent, issue);

	// Build the MCP flags and working dir. Worktree prep streams setup lines to
	// the same run-log channel that carries the agent's own stdout/stderr.
	const logBuffer: { bytes: number; parts: string[]; truncated: boolean } = {
		bytes: 0,
		parts: [],
		truncated: false,
	};

	const persistChunk = (stream: 'stdout' | 'stderr', text: string) => {
		if (logBuffer.truncated) return;
		const marker = stream === 'stderr' ? `[stderr] ${text}` : text;
		const remaining = LOG_CAP_BYTES - logBuffer.bytes;
		if (remaining <= 0) {
			logBuffer.truncated = true;
			return;
		}
		if (marker.length > remaining) {
			logBuffer.parts.push(marker.slice(0, remaining));
			logBuffer.bytes = LOG_CAP_BYTES;
			logBuffer.truncated = true;
		} else {
			logBuffer.parts.push(marker);
			logBuffer.bytes += marker.length;
		}
	};

	const broadcast = (stream: 'stdout' | 'stderr', text: string) => {
		persistChunk(stream, text);
		deps.wsManager?.broadcast(`project-runs:${project.id}`, {
			type: WsMessageType.RunLog,
			projectId: project.id,
			runId: heartbeatRunId,
			issueId: issue.id,
			stream,
			text,
		});
	};

	const mcpFlags =
		runtimeType === 'claude_code'
			? [
					'--mcp-config',
					JSON.stringify({
						mcpServers: {
							hezo: {
								type: 'http',
								url: `http://host.docker.internal:${deps.serverPort}/mcp`,
								headers: { Authorization: `Bearer ${agentJwt}` },
							},
						},
					}),
					'--strict-mcp-config',
				]
			: [];

	const prep = await prepareWorktrees(deps, agent, project, issue, broadcast, signal);

	const execCmd = [cliCommand, ...mcpFlags, ...effortApplication.extraArgs, '-p', taskPrompt];

	// Redact JWT for persisted invocation. Keep everything else so operators can
	// see exactly what was invoked.
	const redactedCmd = execCmd.map((arg) => arg.replace(/Bearer [^"\s]+/g, 'Bearer ***'));
	const invocationCommand = `$ ${redactedCmd
		.map((a) => (a.includes(' ') || a.includes('"') ? JSON.stringify(a) : a))
		.join(' ')}`;

	await deps.db.query(
		`UPDATE heartbeat_runs SET invocation_command = $1, working_dir = $2 WHERE id = $3`,
		[invocationCommand, prep.workingDir, heartbeatRunId],
	);

	broadcast('stdout', `${invocationCommand}\n`);

	try {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		const execId = await deps.docker.execCreate(project.container_id, {
			Cmd: execCmd,
			Env: env,
			WorkingDir: prep.workingDir,
			AttachStdout: true,
			AttachStderr: true,
		});

		const onChunk = async (chunk: ExecLogChunk) => {
			broadcast(chunk.stream, chunk.text);
		};

		const { stdout, stderr } = await deps.docker.execStart(execId, { signal, onChunk });
		const execInfo = await deps.docker.execInspect(execId);
		const durationMs = Date.now() - startTime;

		const success = execInfo.ExitCode === 0;

		await updateHeartbeatRun(deps.db, heartbeatRunId, {
			status: success ? HeartbeatRunStatus.Succeeded : HeartbeatRunStatus.Failed,
			exitCode: execInfo.ExitCode,
			durationMs,
			logText: finalizeLogText(logBuffer),
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
		const isAbort = (error as Error).name === 'AbortError';
		const errorMessage = (error as Error).message;

		broadcast('stderr', `\n[runner] ${errorMessage}\n`);

		await updateHeartbeatRun(deps.db, heartbeatRunId, {
			status: isAbort ? HeartbeatRunStatus.Cancelled : HeartbeatRunStatus.Failed,
			exitCode: -1,
			durationMs,
			logText: finalizeLogText(logBuffer),
			error: errorMessage,
		});

		return {
			success: false,
			exitCode: -1,
			stdout: '',
			stderr: errorMessage,
			durationMs,
			heartbeatRunId,
		};
	}
}

function finalizeLogText(buffer: { parts: string[]; truncated: boolean; bytes: number }): string {
	const text = buffer.parts.join('');
	if (buffer.truncated) {
		return `${text}\n...[truncated — log capped at ${LOG_CAP_BYTES} bytes]`;
	}
	return text;
}

function abortedResult(startTime: number): RunResult {
	return {
		success: false,
		exitCode: -1,
		stdout: '',
		stderr: 'Aborted',
		durationMs: Date.now() - startTime,
	};
}

async function prepareWorktrees(
	deps: RunnerDeps,
	_agent: AgentInfo,
	project: ProjectInfo,
	issue: IssueInfo,
	broadcast: (stream: 'stdout' | 'stderr', text: string) => void,
	signal?: AbortSignal,
): Promise<{ workingDir: string; designatedRepo: RepoRow | null }> {
	const repos = await deps.db.query<RepoRow>(
		`SELECT id, short_name, repo_identifier FROM repos
		 WHERE project_id = $1 ORDER BY created_at ASC`,
		[project.id],
	);

	if (repos.rows.length === 0) {
		broadcast('stdout', '(no repos linked to project — running in /workspace)\n');
		return { workingDir: '/workspace', designatedRepo: null };
	}

	// Best-effort reconcile: ensures any newly-added or previously-failed clone
	// is present before the agent starts.
	const syncRes = await ensureProjectRepos(
		deps.db,
		deps.masterKeyManager,
		{
			id: project.id,
			company_id: project.company_id,
			companySlug: project.company_slug,
			projectSlug: project.slug,
		},
		deps.dataDir,
		(stream, text) => broadcast(stream, `${text}\n`),
	);
	if (syncRes.cloned.length > 0) {
		broadcast('stdout', `(cloned ${syncRes.cloned.length} repo(s) on demand)\n`);
	}

	if (signal?.aborted) return { workingDir: '/workspace', designatedRepo: null };

	const companySshKey = await getCompanySSHKey(deps.db, project.company_id, deps.masterKeyManager);

	const workspaceRoot = getWorkspacePath(deps.dataDir, project.company_slug, project.slug);
	const worktreesRoot = getWorktreesPath(deps.dataDir, project.company_slug, project.slug);
	const issueWorktreeRoot = join(worktreesRoot, issue.identifier);
	mkdirSync(issueWorktreeRoot, { recursive: true });

	const branchName = `hezo/${issue.identifier}`;

	for (const repo of repos.rows) {
		if (signal?.aborted) break;
		const repoDir = join(workspaceRoot, repo.short_name);
		const worktreePath = join(issueWorktreeRoot, repo.short_name);

		if (!existsSync(join(repoDir, '.git'))) {
			broadcast('stderr', `(skipping worktree for ${repo.short_name} — not cloned)\n`);
			continue;
		}

		if (companySshKey) {
			const fetchRes = await fetchRepo(repoDir, companySshKey.privateKey);
			if (fetchRes.success) {
				broadcast('stdout', `git fetch ${repo.short_name}\n`);
			} else {
				broadcast('stderr', `git fetch ${repo.short_name} failed: ${fetchRes.error ?? '?'}\n`);
			}
		}

		const wt = await ensureIssueWorktree(repoDir, worktreePath, branchName);
		if (!wt.success) {
			broadcast('stderr', `git worktree for ${repo.short_name} failed: ${wt.error ?? 'unknown'}\n`);
		} else if (wt.created) {
			broadcast('stdout', `git worktree add ${repo.short_name} @ ${branchName}\n`);
		}
	}

	const designated = project.designated_repo_id
		? repos.rows.find((r) => r.id === project.designated_repo_id)
		: null;
	const primary = designated ?? repos.rows[0];
	const workingDir = `/worktrees/${issue.identifier}/${primary.short_name}`;

	return { workingDir, designatedRepo: primary ?? null };
}

export function buildTaskPrompt(
	systemPrompt: string,
	issue: IssueInfo,
	wakeupPayload?: Record<string, unknown>,
): string {
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

	if (wakeupPayload?.previous_failure) {
		const pf = wakeupPayload.previous_failure as Record<string, unknown>;
		parts.push('');
		parts.push(`## Retry Attempt ${wakeupPayload.retry_count}/${wakeupPayload.max_retries}`);
		parts.push('The previous attempt FAILED. Analyze the error and try a different approach.');
		if (pf.exit_code !== undefined && pf.exit_code !== null)
			parts.push(`**Exit code:** ${pf.exit_code}`);
		if (pf.stderr_tail) parts.push(`**Error output:**\n\`\`\`\n${pf.stderr_tail}\n\`\`\``);
		if (pf.stdout_tail) parts.push(`**Last output:**\n\`\`\`\n${pf.stdout_tail}\n\`\`\``);
	}

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

async function createHeartbeatRun(db: PGlite, agent: AgentInfo, issue: IssueInfo): Promise<string> {
	const result = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())
		 RETURNING id`,
		[agent.id, agent.company_id, issue.id, HeartbeatRunStatus.Running],
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
		logText?: string;
		error?: string;
	},
): Promise<void> {
	await db.query(
		`UPDATE heartbeat_runs
		 SET status = $1::heartbeat_run_status,
		     finished_at = now(),
		     exit_code = $2,
		     log_text = $3,
		     error = COALESCE($4, error)
		 WHERE id = $5`,
		[update.status, update.exitCode, update.logText ?? '', update.error ?? null, runId],
	);
}
