import { Link } from '@tanstack/react-router';
import { DoorOpen, Loader2, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { type ContainerHealth, useContainerHealth } from '../../hooks/use-container-health';
import { formatElapsed } from '../../hooks/use-elapsed-duration';
import {
	getRunWaitingMessage,
	isActiveRunStatus,
	useHeartbeatRun,
} from '../../hooks/use-heartbeat-runs';
import { useProjectMeta } from '../../hooks/use-projects';
import { useRetryFailedRun } from '../../hooks/use-retry-failed-run';
import { useRunLogs } from '../../hooks/use-run-logs';
import { agentPageParams } from '../agent-link';
import { LazyMount } from '../lazy-mount';
import { LogViewer } from '../log-viewer';
import { useOpenPreview } from '../task-detail/preview-context';
import { TerminateRunButton } from '../terminate-run-button';
import { Tooltip } from '../ui/tooltip';
import type { CommentDataOf } from './comment-data';
import { CommentTimestampLink } from './comment-timestamp-link';
import { runStatusDotClass, runStatusLabel } from './helpers';

interface Props {
	comment: CommentDataOf<'run'>;
	projectId?: string;
	taskId?: string;
	/** The run_id eligible for a Retry button — the latest run, only when none is active/queued. */
	retryableRunId?: string | null;
	inline?: boolean;
}

export function RunComment({ comment, projectId, taskId, retryableRunId, inline }: Props) {
	const runId = comment.content?.run_id ?? '';
	const agentId = comment.content?.agent_id ?? '';
	const agentTitle = comment.content?.agent_title ?? 'Agent';
	const agentSlug = comment.content?.agent_slug ?? '';
	const actorName = comment.content?.actor_name ?? null;

	if (!projectId || !runId || !agentId) {
		return <p className="text-xs text-text-3 italic">Run reference missing.</p>;
	}

	return (
		<div className="flex flex-col gap-1.5" data-testid="run-comment">
			<LazyMount minHeight={210} testId="run-comment-lazy">
				<RunCommentBody
					projectId={projectId}
					runId={runId}
					agentId={agentId}
					agentTitle={agentTitle}
					agentSlug={agentSlug}
					actorName={actorName}
					createdAt={comment.created_at}
					publicId={comment.public_id}
					taskId={taskId}
					retryableRunId={retryableRunId}
					inline={inline}
				/>
			</LazyMount>
		</div>
	);
}

/** Short provenance hint for a created skill, e.g. "skills.sh" or "github.com". */
function skillSourceLabel(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return 'source';
	}
}

/** Why a retry is currently blocked — keyed off the same health the banner reads. */
function containerNotReadyReason(health: ContainerHealth | null): string {
	switch (health?.kind) {
		case 'rebuilding':
			return 'Container is rebuilding — retry will be available once it finishes';
		case 'provisioning':
			return 'Container is starting up — retry will be available once it is running';
		default:
			// stopped, error, or the project index has not loaded yet.
			return 'Container is not running — start it from the Container page to retry';
	}
}

function RunRetryButton({
	projectId,
	taskId,
	runId,
}: {
	projectId: string;
	taskId: string;
	runId: string;
}) {
	const retry = useRetryFailedRun({ projectId, taskId });
	const project = useProjectMeta(projectId);
	const health = useContainerHealth(project);
	// A run can only be dispatched into a healthy container (running, and not mid
	// base-image rebuild). Mirror the runtime gate so a click can't queue a retry
	// that would immediately fail on a missing/stopped container.
	const containerReady = health?.kind === 'healthy';
	return (
		<Tooltip content={containerReady ? 'Retry this run' : containerNotReadyReason(health)}>
			<button
				type="button"
				onClick={() => retry.mutate(runId)}
				disabled={retry.isPending || !containerReady}
				aria-label="Retry failed run"
				data-testid="retry-failed-run"
				className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium text-text-2 hover:bg-surface-2 hover:text-text-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
			>
				{retry.isPending ? (
					<Loader2 className="w-3 h-3 animate-spin" />
				) : (
					<RotateCw className="w-3 h-3" />
				)}
				Retry
			</button>
		</Tooltip>
	);
}

function RunCommentBody({
	projectId,
	runId,
	agentId,
	agentTitle,
	agentSlug,
	actorName,
	createdAt,
	publicId,
	taskId,
	retryableRunId,
	inline,
}: {
	projectId: string;
	runId: string;
	agentId: string;
	agentTitle: string;
	agentSlug: string;
	actorName: string | null;
	createdAt: string;
	publicId: string;
	taskId?: string;
	retryableRunId?: string | null;
	inline?: boolean;
}) {
	const runQuery = useHeartbeatRun(projectId, agentId, runId);
	const run = runQuery.data;
	const status = run?.status ?? 'queued';
	const isActive = isActiveRunStatus(status);
	// Offer a manual retry on a failed/timed-out run, but only on the latest run
	// and only when nothing is already running or queued for this task — that's
	// exactly what `retryableRunId` resolves to (null otherwise).
	const canRetry =
		Boolean(taskId) && runId === retryableRunId && (status === 'failed' || status === 'timed_out');
	const { lines } = useRunLogs(run?.project_id, runId, run?.log_text, isActive);
	const createdTasks = run?.created_tasks ?? [];
	const createdDocs = run?.created_docs ?? [];
	const createdSkills = run?.created_skills ?? [];
	const proposedSkills = run?.proposed_skills ?? [];
	const completed = run != null && !isActive;
	const durationMs =
		run?.started_at && run.finished_at
			? Math.max(0, new Date(run.finished_at).getTime() - new Date(run.started_at).getTime())
			: null;
	const [expanded, setExpanded] = useState(false);
	const logRegionId = `run-comment-log-${runId}`;
	// On a surface that hosts the preview panel (task detail), an updated-doc link
	// opens the doc in the panel; elsewhere it falls back to the documents page.
	const openPreview = useOpenPreview();
	// HQ agents link to their canonical page in the HQ project; others to this
	// project. Falls back to the run's member id when an older comment lacks a slug.
	const agentLinkParams = agentSlug
		? agentPageParams(projectId, agentSlug)
		: { projectId, agentId };

	// Single non-wrapping row: the agent title and status block keep their width,
	// the timestamp truncates first under pressure, and the status block clips
	// last — so the header (and its expand chevron) stay on one horizontal line at
	// any width, including once the log opens and a scrollbar narrows the row.
	const summaryRow = (
		<span className="flex flex-1 items-center gap-x-2 min-w-0 overflow-hidden">
			<Link
				to="/projects/$projectId/agents/$agentId"
				params={agentLinkParams}
				onClick={(e) => e.stopPropagation()}
				className="text-xs text-text-2 shrink-0 whitespace-nowrap hover:text-text-1 hover:underline"
			>
				{agentTitle} run
			</Link>
			{actorName && (
				<span
					className="hidden sm:inline-flex items-center text-xs text-text-3 shrink-0 whitespace-nowrap"
					data-testid="run-comment-actor"
				>
					<span aria-hidden="true">·</span>
					<span className="ml-1.5">started by {actorName}</span>
				</span>
			)}
			{completed && (
				<span
					className="inline-flex items-center gap-1.5 text-xs text-text-3 shrink-0 whitespace-nowrap"
					data-testid="run-comment-summary"
				>
					<span
						aria-hidden="true"
						className={`inline-block w-2 h-2 rounded-full ${runStatusDotClass(status)}`}
					/>
					<span>{runStatusLabel(status)}</span>
					<span aria-hidden="true" className="hidden sm:inline">
						·
					</span>
					<span className="hidden sm:inline" data-testid="run-comment-line-count">
						{lines.length} {lines.length === 1 ? 'line' : 'lines'}
					</span>
					{durationMs != null && (
						<>
							<span aria-hidden="true">·</span>
							<span data-testid="run-comment-duration">{formatElapsed(durationMs)}</span>
						</>
					)}
					{run?.cost_cents != null && run.cost_cents > 0 && (
						<>
							<span aria-hidden="true" className="hidden sm:inline">
								·
							</span>
							<span className="hidden sm:inline" data-testid="run-comment-cost">
								${(run.cost_cents / 100).toFixed(2)}
							</span>
						</>
					)}
				</span>
			)}
			<CommentTimestampLink
				publicId={publicId}
				createdAt={createdAt}
				className="truncate min-w-0"
			/>
		</span>
	);

	// The expand/collapse toggle. `flex-1` is added only when a sibling Retry
	// button shares the row; without it the markup stays byte-identical to the
	// pre-Retry header, so a non-retryable run's clickable geometry is unchanged.
	const expandToggle = (
		<button
			type="button"
			onClick={() => setExpanded((v) => !v)}
			aria-expanded={expanded}
			aria-controls={logRegionId}
			data-testid="run-comment-header"
			className={`flex items-center gap-2 min-h-[26px] min-w-0 text-left -mx-1 px-1 rounded-md hover:bg-surface-3 cursor-pointer${
				canRetry && taskId ? ' flex-1' : ''
			}`}
		>
			{summaryRow}
			<svg
				aria-hidden="true"
				className={`w-3 h-3 shrink-0 text-text-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
				viewBox="0 0 16 16"
				fill="currentColor"
			>
				<path d="M6 3l5 5-5 5V3z" />
			</svg>
		</button>
	);

	return (
		<>
			{inline &&
				(completed ? (
					canRetry && taskId ? (
						<div className="flex items-center gap-1 min-w-0">
							{expandToggle}
							<RunRetryButton projectId={projectId} taskId={taskId} runId={runId} />
						</div>
					) : (
						expandToggle
					)
				) : (
					<div className="flex items-center min-h-[26px] min-w-0" data-testid="run-comment-header">
						{summaryRow}
					</div>
				))}
			{(!completed || expanded) && (
				<div id={logRegionId}>
					<LogViewer
						lines={lines}
						compact
						formattable
						projectId={projectId}
						projectSlug={run?.project_slug ?? undefined}
						commentRefTask={
							run?.task_identifier
								? {
										identifier: run.task_identifier,
										title: run.task_title ?? '',
										projectSlug: run.project_slug ?? projectId,
									}
								: undefined
						}
						heightClassName="h-[180px]"
						testId="run-comment-log"
						liveLabel={
							<span className="flex items-center gap-1.5">
								<span
									className={`inline-block w-2 h-2 rounded-full ${runStatusDotClass(status)}`}
								/>
								<span>
									{agentTitle} — {runStatusLabel(status)}
								</span>
							</span>
						}
						emptyState={getRunWaitingMessage(status, run?.queued_reason)}
						headerActionLeading={
							<TerminateRunButton
								projectId={projectId}
								agentId={agentId}
								runId={runId}
								status={status}
								taskId={run?.task_id ?? null}
							/>
						}
						headerAction={
							<Tooltip content="View full run">
								<Link
									to="/projects/$projectId/agents/$agentId/executions/$runId"
									params={{ ...agentLinkParams, runId }}
									aria-label="View full run"
									className="inline-flex items-center justify-center h-6 px-2 text-xs text-text-2 hover:text-text-1 hover:bg-surface-3 rounded-md transition-colors"
								>
									<DoorOpen className="w-3 h-3" />
								</Link>
							</Tooltip>
						}
					/>
				</div>
			)}
			{createdTasks.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-created-tasks">
					{createdTasks.map((task) => (
						<Link
							key={task.id}
							to="/projects/$projectId/tasks/$taskId"
							params={{
								projectId: task.project_slug,
								taskId: task.identifier.toLowerCase(),
							}}
							className="text-xs text-info-soft-fg hover:underline self-start"
						>
							Created ticket {task.identifier} — {task.title}
						</Link>
					))}
				</div>
			)}
			{createdDocs.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-created-docs">
					{createdDocs.map((doc) =>
						openPreview ? (
							<button
								key={doc.filename}
								type="button"
								onClick={() =>
									openPreview({
										projectId: doc.project_slug,
										projectSlug: doc.project_slug,
										filename: doc.filename,
									})
								}
								className="text-xs text-info-soft-fg hover:underline self-start text-left"
								data-testid="run-comment-doc-link"
							>
								Updated {doc.filename}
							</button>
						) : (
							<Link
								key={doc.filename}
								to="/projects/$projectId/documents"
								params={{ projectId: doc.project_slug }}
								search={{ file: doc.filename }}
								className="text-xs text-info-soft-fg hover:underline self-start"
								data-testid="run-comment-doc-link"
							>
								Updated {doc.filename}
							</Link>
						),
					)}
				</div>
			)}
			{createdSkills.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-created-skills">
					{createdSkills.map((skill) => (
						<span key={skill.slug} className="text-xs self-start">
							<Link to="/settings/skills" className="text-info-soft-fg hover:underline">
								{skill.created ? 'Added' : 'Updated'} skill {skill.name}
							</Link>
							{skill.source_url && (
								<span className="text-text-3"> · from {skillSourceLabel(skill.source_url)}</span>
							)}
						</span>
					))}
				</div>
			)}
			{proposedSkills.length > 0 && (
				<div className="flex flex-col gap-1 pt-1" data-testid="run-comment-proposed-skills">
					{proposedSkills.map((skill) => (
						<Link
							key={skill.slug}
							to="/projects/$projectId/inbox"
							params={{ projectId }}
							className="text-xs text-info-soft-fg hover:underline self-start"
						>
							Proposed skill {skill.name}
						</Link>
					))}
				</div>
			)}
		</>
	);
}
