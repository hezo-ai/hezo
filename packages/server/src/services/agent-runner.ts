import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
	AgentRuntime,
	type AiProvider,
	CommentContentType,
	ContainerStatus,
	HeartbeatRunStatus,
	PROVIDER_TO_ENV_VAR,
	PROVIDER_TO_RUNTIME,
	RUNTIME_AUTO_APPROVE_ARGS,
	RUNTIME_COMMANDS,
	RUNTIME_STREAM_ARGS,
	RUNTIME_TO_PROVIDER,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { broadcastRowChange } from '../lib/broadcast';
import { signAgentJwt } from '../middleware/auth';
import { type AgentRunUsage, createAgentStreamParser } from './agent-stream-parser';
import { type AiProviderCredential, getProviderCredentialAndModel } from './ai-provider-keys';
import type { DockerClient, ExecLogChunk } from './docker';
import { applyEffortToRuntime, type EffortRuntimeApplication, resolveEffort } from './effort';
import { ensureIssueWorktree, fetchRepo } from './git';
import type { LogStreamBroker } from './log-stream-broker';
import { ensureProjectRepos } from './repo-sync';
import { resolveRuntimeForIssue } from './runtime-resolver';
import { getCompanySSHKey } from './ssh-keys';
import { resolveSystemPrompt } from './template-resolver';
import { getWorkspacePath, getWorktreesPath } from './workspace';
import type { WebSocketManager } from './ws';

export interface AgentInfo {
	id: string;
	title: string;
	slug?: string | null;
	system_prompt: string;
	company_id: string;
	default_effort?: string | null;
	model_override_provider?: AiProvider | null;
	model_override_model?: string | null;
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
	runtime_type?: AgentRuntime | null;
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
	logs: LogStreamBroker;
}

interface RepoRow {
	id: string;
	short_name: string;
	repo_identifier: string;
}

/**
 * Build the env-var entries for a given provider/auth method. Only the matching
 * env var is set; agents that read a different var won't see the credential.
 */
export function buildProviderEnv(provider: AiProvider, credential: AiProviderCredential): string[] {
	const envVarName = PROVIDER_TO_ENV_VAR[provider]?.[credential.authMethod];
	if (!envVarName) return [];
	return [`${envVarName}=${credential.value}`];
}

interface RunContext {
	cmd: string[];
	env: string[];
	taskPrompt: string;
	effort: string;
	effortApplication: EffortRuntimeApplication;
	agentJwt: string;
}

async function buildRunContext(
	deps: RunnerDeps,
	agent: AgentInfo,
	issue: IssueInfo,
	project: ProjectInfo,
	wakeupPayload: Record<string, unknown> | undefined,
	credential: AiProviderCredential,
	provider: AiProvider,
	runtimeType: AgentRuntime,
	heartbeatRunId: string,
	modelOverride: string | null,
): Promise<RunContext> {
	let resolvedPrompt = await resolveSystemPrompt(deps.db, agent.system_prompt, {
		companyId: agent.company_id,
		projectId: project.id,
		issueId: issue.id,
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

	const agentJwt = await signAgentJwt(
		deps.masterKeyManager,
		agent.id,
		agent.company_id,
		heartbeatRunId,
	);
	const effort = resolveEffort(wakeupPayload?.effort, agent.default_effort, agent.slug);
	const effortApplication = applyEffortToRuntime(runtimeType, effort);

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
		...buildProviderEnv(provider, credential),
	];

	const cliCommand = RUNTIME_COMMANDS[runtimeType];
	const mcpFlags =
		runtimeType === AgentRuntime.ClaudeCode
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

	const modelArgs = modelOverride ? ['--model', modelOverride] : [];

	const cmd = [
		cliCommand,
		...mcpFlags,
		...RUNTIME_STREAM_ARGS[runtimeType],
		...RUNTIME_AUTO_APPROVE_ARGS[runtimeType],
		...effortApplication.extraArgs,
		...modelArgs,
		'-p',
		taskPrompt,
	];

	return { cmd, env, taskPrompt, effort, effortApplication, agentJwt };
}

export type ContainerExitAbortReason = 'container_error' | 'container_stopped';

function exitReasonFromSignal(signal?: AbortSignal): ContainerExitAbortReason | null {
	if (!signal) return null;
	const reason = signal.reason as unknown;
	if (reason === 'container_error' || reason === 'container_stopped') return reason;
	return null;
}

export async function runAgent(
	deps: RunnerDeps,
	agent: AgentInfo,
	issue: IssueInfo,
	project: ProjectInfo,
	wakeupPayload?: Record<string, unknown>,
	signal?: AbortSignal,
	onRunRegistered?: (heartbeatRunId: string) => void,
): Promise<RunResult> {
	const startTime = Date.now();

	if (signal?.aborted) return abortedResult(startTime);

	const runBroadcast: HeartbeatRunBroadcast = {
		wsManager: deps.wsManager,
		companyId: agent.company_id,
		issueId: issue.id,
		memberId: agent.id,
	};
	const heartbeatRunId = await createHeartbeatRun(deps.db, agent, issue, runBroadcast);
	onRunRegistered?.(heartbeatRunId);
	const streamId = `run:${heartbeatRunId}`;

	deps.logs.begin({
		streamId,
		room: `project-runs:${project.id}`,
		buildMessage: (line) => ({
			type: WsMessageType.RunLog,
			projectId: project.id,
			runId: heartbeatRunId,
			issueId: issue.id,
			stream: line.stream,
			text: line.text,
		}),
		onFlush: async (text) => {
			await deps.db.query('UPDATE heartbeat_runs SET log_text = $1 WHERE id = $2', [
				text,
				heartbeatRunId,
			]);
		},
	});

	const emit = (stream: 'stdout' | 'stderr', text: string) =>
		deps.logs.emit(streamId, stream, text);

	const finalizeFailure = async (message: string): Promise<RunResult> => {
		emit('stderr', `[runner] ${message}\n`);
		const durationMs = Date.now() - startTime;
		await deps.logs.end(streamId);
		await updateHeartbeatRun(
			deps.db,
			heartbeatRunId,
			{
				status: HeartbeatRunStatus.Failed,
				exitCode: -1,
				durationMs,
				error: message,
			},
			runBroadcast,
		);
		return {
			success: false,
			exitCode: -1,
			stdout: '',
			stderr: message,
			durationMs,
			heartbeatRunId,
		};
	};

	const finalizeAbort = async (): Promise<RunResult> => {
		const durationMs = Date.now() - startTime;
		await deps.logs.end(streamId);
		const exitReason = exitReasonFromSignal(signal);
		const status = exitReason ? HeartbeatRunStatus.Failed : HeartbeatRunStatus.Cancelled;
		await updateHeartbeatRun(
			deps.db,
			heartbeatRunId,
			{
				status,
				exitCode: -1,
				durationMs,
				error: exitReason ?? undefined,
			},
			runBroadcast,
		);
		return {
			success: false,
			exitCode: -1,
			stdout: '',
			stderr: exitReason ?? 'Aborted',
			durationMs,
			heartbeatRunId,
		};
	};

	if (!project.container_id || project.container_status !== ContainerStatus.Running) {
		return finalizeFailure(
			'Project container is not running. Start the container from the Project page and retry.',
		);
	}

	let provider: AiProvider;
	let runtimeType: AgentRuntime;
	if (agent.model_override_provider) {
		provider = agent.model_override_provider;
		runtimeType = PROVIDER_TO_RUNTIME[provider];
	} else {
		const resolved = await resolveRuntimeForIssue(deps.db, issue.runtime_type ?? null);
		if (!resolved) {
			return finalizeFailure(
				'No AI provider credentials configured at the instance level. Add one in Settings > AI Providers.',
			);
		}
		runtimeType = resolved;
		provider = RUNTIME_TO_PROVIDER[runtimeType];
	}

	const credential = await getProviderCredentialAndModel(deps.db, deps.masterKeyManager, provider);
	if (!credential) {
		return finalizeFailure(
			`No ${provider} credential configured. Add one in Settings > AI Providers.`,
		);
	}

	const modelOverride = agent.model_override_model ?? credential.defaultModel ?? null;

	if (signal?.aborted) return finalizeAbort();

	const context = await buildRunContext(
		deps,
		agent,
		issue,
		project,
		wakeupPayload,
		credential,
		provider,
		runtimeType,
		heartbeatRunId,
		modelOverride,
	);

	if (signal?.aborted) return finalizeAbort();

	const prep = await prepareWorktrees(deps, project, issue, emit, signal);

	const redactedCmd = context.cmd.map((arg) => arg.replace(/Bearer [^"\s]+/g, 'Bearer ***'));
	const invocationCommand = `$ ${redactedCmd.map(shellQuoteArg).join(' ')}`;

	await deps.db.query(
		`UPDATE heartbeat_runs SET invocation_command = $1, working_dir = $2 WHERE id = $3`,
		[invocationCommand, prep.workingDir, heartbeatRunId],
	);

	emit('stdout', `${invocationCommand}\n`);

	const parser = createAgentStreamParser(runtimeType);

	try {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

		const execId = await deps.docker.execCreate(project.container_id, {
			Cmd: context.cmd,
			Env: context.env,
			WorkingDir: prep.workingDir,
			User: 'node',
			AttachStdout: true,
			AttachStderr: true,
		});

		const onChunk = async (chunk: ExecLogChunk) => {
			const rendered =
				chunk.stream === 'stdout' ? parser.onStdout(chunk.text) : parser.onStderr(chunk.text);
			if (rendered) emit(chunk.stream, rendered);
		};

		const { stdout, stderr } = await deps.docker.execStart(execId, { signal, onChunk });
		const tail = parser.flush();
		if (tail) emit('stdout', tail);
		const execInfo = await deps.docker.execInspect(execId);
		const durationMs = Date.now() - startTime;
		const success = execInfo.ExitCode === 0;

		await deps.logs.end(streamId);
		await updateHeartbeatRun(
			deps.db,
			heartbeatRunId,
			{
				status: success ? HeartbeatRunStatus.Succeeded : HeartbeatRunStatus.Failed,
				exitCode: execInfo.ExitCode,
				durationMs,
				usage: parser.getUsage(),
			},
			runBroadcast,
		);

		return { success, exitCode: execInfo.ExitCode, stdout, stderr, durationMs, heartbeatRunId };
	} catch (error) {
		const durationMs = Date.now() - startTime;
		const isAbort = (error as Error).name === 'AbortError';
		const exitReason = exitReasonFromSignal(signal);
		const errorMessage = exitReason ?? (error as Error).message;
		const status = isAbort
			? exitReason
				? HeartbeatRunStatus.Failed
				: HeartbeatRunStatus.Cancelled
			: HeartbeatRunStatus.Failed;

		emit('stderr', `\n[runner] ${errorMessage}\n`);

		await deps.logs.end(streamId);
		await updateHeartbeatRun(
			deps.db,
			heartbeatRunId,
			{
				status,
				exitCode: -1,
				durationMs,
				error: errorMessage,
			},
			runBroadcast,
		);

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

function failedResult(stderr: string, startTime: number): RunResult {
	return { success: false, exitCode: -1, stdout: '', stderr, durationMs: Date.now() - startTime };
}

function abortedResult(startTime: number): RunResult {
	return failedResult('Aborted', startTime);
}

export function shellQuoteArg(arg: string): string {
	if (arg === '') return "''";
	if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function prepareWorktrees(
	deps: RunnerDeps,
	project: ProjectInfo,
	issue: IssueInfo,
	emit: (stream: 'stdout' | 'stderr', text: string) => void,
	signal?: AbortSignal,
): Promise<{ workingDir: string; designatedRepo: RepoRow | null }> {
	const repos = await deps.db.query<RepoRow>(
		`SELECT id, short_name, repo_identifier FROM repos
		 WHERE project_id = $1 ORDER BY created_at ASC`,
		[project.id],
	);

	if (repos.rows.length === 0) {
		emit('stdout', '(no repos linked to project — running in /workspace)\n');
		return { workingDir: '/workspace', designatedRepo: null };
	}

	emit('stdout', '(syncing repos...)\n');
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
		(stream, text) => emit(stream, `${text}\n`),
	);
	if (syncRes.cloned.length > 0) {
		emit('stdout', `(cloned ${syncRes.cloned.length} repo(s) on demand)\n`);
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
			emit('stderr', `(skipping worktree for ${repo.short_name} — not cloned)\n`);
			continue;
		}

		if (companySshKey) {
			emit('stdout', `git fetch ${repo.short_name}...\n`);
			const fetchRes = await fetchRepo(repoDir, companySshKey.privateKey);
			if (fetchRes.success) {
				emit('stdout', `git fetch ${repo.short_name} done\n`);
			} else {
				emit('stderr', `git fetch ${repo.short_name} failed: ${fetchRes.error ?? '?'}\n`);
			}
		}

		emit('stdout', `git worktree ${repo.short_name}...\n`);
		const wt = await ensureIssueWorktree(repoDir, worktreePath, branchName);
		if (!wt.success) {
			emit('stderr', `git worktree for ${repo.short_name} failed: ${wt.error ?? 'unknown'}\n`);
		} else if (wt.created) {
			emit('stdout', `git worktree add ${repo.short_name} @ ${branchName}\n`);
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

export interface HeartbeatRunBroadcast {
	wsManager?: WebSocketManager;
	companyId: string;
	issueId: string;
	memberId: string;
}

function broadcastHeartbeatRunChange(
	ctx: HeartbeatRunBroadcast,
	runId: string,
	status: string,
	action: 'INSERT' | 'UPDATE',
): void {
	if (!ctx.wsManager) return;
	broadcastRowChange(ctx.wsManager, wsRoom.company(ctx.companyId), 'heartbeat_runs', action, {
		id: runId,
		issue_id: ctx.issueId,
		company_id: ctx.companyId,
		member_id: ctx.memberId,
		status,
	});
}

export async function createHeartbeatRun(
	db: PGlite,
	agent: AgentInfo,
	issue: IssueInfo,
	broadcast: HeartbeatRunBroadcast,
): Promise<string> {
	await db.query('BEGIN');
	let runId: string;
	try {
		const runResult = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now())
			 RETURNING id`,
			[agent.id, agent.company_id, issue.id, HeartbeatRunStatus.Running],
		);
		runId = runResult.rows[0].id;

		await db.query(
			`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)`,
			[
				issue.id,
				agent.id,
				CommentContentType.Run,
				JSON.stringify({ run_id: runId, agent_id: agent.id, agent_title: agent.title }),
			],
		);
		await db.query('COMMIT');
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}

	broadcastHeartbeatRunChange(broadcast, runId, HeartbeatRunStatus.Running, 'INSERT');
	if (broadcast.wsManager) {
		broadcastRowChange(
			broadcast.wsManager,
			wsRoom.company(broadcast.companyId),
			'issue_comments',
			'INSERT',
			{
				issue_id: issue.id,
			},
		);
	}
	return runId;
}

async function updateHeartbeatRun(
	db: PGlite,
	runId: string,
	update: {
		status: string;
		exitCode: number;
		durationMs: number;
		error?: string;
		usage?: AgentRunUsage | null;
	},
	broadcast: HeartbeatRunBroadcast,
): Promise<void> {
	await db.query(
		`UPDATE heartbeat_runs
		 SET status = $1::heartbeat_run_status,
		     finished_at = now(),
		     exit_code = $2,
		     error = COALESCE($3, error),
		     input_tokens = COALESCE($4, input_tokens),
		     output_tokens = COALESCE($5, output_tokens),
		     cost_cents = COALESCE($6, cost_cents)
		 WHERE id = $7`,
		[
			update.status,
			update.exitCode,
			update.error ?? null,
			update.usage?.inputTokens ?? null,
			update.usage?.outputTokens ?? null,
			update.usage?.costCents ?? null,
			runId,
		],
	);
	broadcastHeartbeatRunChange(broadcast, runId, update.status, 'UPDATE');
}
