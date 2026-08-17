import { HeartbeatRunStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, DoorOpen, Loader2, RotateCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useAgentLookup } from '../../hooks/use-agent-lookup';
import { type ContainerHealth, useContainerHealth } from '../../hooks/use-container-health';
import { formatElapsed, useElapsedDuration } from '../../hooks/use-elapsed-duration';
import {
	getRunWaitingMessage,
	isActiveRunStatus,
	useHeartbeatRun,
} from '../../hooks/use-heartbeat-runs';
import { useProjectMeta } from '../../hooks/use-projects';
import { useRetryFailedRun } from '../../hooks/use-retry-failed-run';
import { useRunLogs } from '../../hooks/use-run-logs';
import { useI18n } from '../../lib/i18n';
import { agentDisplayName } from '../agent-identity-tooltip';
import { agentPageParams } from '../agent-link';
import { LazyMount } from '../lazy-mount';
import { LogViewer } from '../log-viewer';
import { useOpenPreview } from '../task-detail/preview-context';
import { TerminateRunButton } from '../terminate-run-button';
import { RelativeTime } from '../ui/relative-time';
import { Tooltip } from '../ui/tooltip';
import type { CommentDataOf } from './comment-data';
import { CommentTimestampLink } from './comment-timestamp-link';
import { runErrorSummary, runStatusDotClass, runStatusLabel } from './helpers';

interface Props {
	comment: CommentDataOf<'run'>;
	projectId?: string;
	taskId?: string;
	/** The run_id eligible for a Retry button — the latest run, only when none is active/queued. */
	retryableRunId?: string | null;
	inline?: boolean;
	/**
	 * Render an active run as the Conversation view's working row: a collapsed
	 * "<agent> is working" pill that opens onto the same live log. Ignored once
	 * the run finishes, which falls back to the ordinary collapsed summary.
	 */
	working?: boolean;
}

export function RunComment({ comment, projectId, taskId, retryableRunId, inline, working }: Props) {
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
					working={working}
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
			return 'Container is rebuilding - retry will be available once it finishes';
		case 'provisioning':
			return 'Container is starting up - retry will be available once it is running';
		default:
			// error, or the project index has not loaded yet (stopped never blocks —
			// the retry lazy-starts the container).
			return 'Container hit an error - fix it from the Container page to retry';
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
	// A stopped container is fine — the runner lazy-starts it. Only block while
	// an error needs fixing or a provision/rebuild is in flight, mirroring the
	// runtime gate.
	const containerReady = health?.kind === 'healthy' || health?.kind === 'stopped';
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

export function RunCommentBody({
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
	working,
}: {
	projectId: string;
	runId: string;
	agentId: string;
	agentTitle: string;
	agentSlug: string;
	actorName: string | null;
	createdAt: string;
	/** Comment public id for the timestamp permalink. Absent for runs with no anchoring
	 * comment (e.g. progress-update runs), which render a plain timestamp instead. */
	publicId?: string;
	taskId?: string;
	retryableRunId?: string | null;
	inline?: boolean;
	working?: boolean;
}) {
	// The comment bakes the role title at write time; resolve the agent live so a
	// later rename shows through, and fall back to the baked label for an agent
	// no longer on the roster.
	const { bySlug } = useAgentLookup(projectId);
	const resolvedAgent = agentSlug ? bySlug.get(agentSlug) : undefined;
	const agentLabel = (resolvedAgent && agentDisplayName(resolvedAgent)) || agentTitle;
	const runQuery = useHeartbeatRun(projectId, agentId, runId);
	const run = runQuery.data;
	const status = run?.status ?? 'queued';
	// Only positively-active once the run has actually loaded. While the per-run
	// query is still resolving (`run == null`), `status` defaults to 'queued' —
	// which would otherwise read as active and force the log open. On a virtualized
	// feed every scroll remount refires this query, so treating "loading" as active
	// made completed entries flash expanded, then collapse once the run resolved.
	// Keeping the unknown/loading state non-active renders it collapsed instead.
	const isActive = run != null && isActiveRunStatus(status);
	// Offer a manual retry on a failed/timed-out run, but only on the latest run
	// and only when nothing is already running or queued for this task — that's
	// exactly what `retryableRunId` resolves to (null otherwise).
	const canRetry =
		Boolean(taskId) &&
		runId === retryableRunId &&
		(status === HeartbeatRunStatus.Failed || status === HeartbeatRunStatus.TimedOut);
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
	// Gated on the error rather than on the status: a cancelled run carries a
	// reason too ("the container it was on stopped", "server shut down while this
	// run was in flight"), and that is exactly the sentence a reader is looking
	// for. The colour follows the status; the presence does not.
	const errorSummary = runErrorSummary(run?.error);
	const errored = status === HeartbeatRunStatus.Failed || status === HeartbeatRunStatus.TimedOut;
	const { t } = useI18n();
	// Ticks live while the run is in flight; empty until it actually starts, so a
	// queued run does not show a stopwatch for work that has not begun.
	const elapsed = useElapsedDuration(run?.started_at ?? '', run?.finished_at ?? null);
	// On a surface that hosts the preview panel (task detail), an updated-doc link
	// opens the doc in the panel; elsewhere it falls back to the documents page.
	const openPreview = useOpenPreview();
	// HQ agents link to their canonical page in the HQ project; others to this
	// project. Falls back to the run's member id when an older comment lacks a slug.
	const agentLinkParams = agentSlug
		? agentPageParams(projectId, agentSlug)
		: { projectId, agentId };

	// Wrapping row: each segment (agent title, status block, timestamp) stays
	// whole via whitespace-nowrap but flows to the next line when the row runs
	// out of width, so a narrow mobile viewport never forces the header — and
	// with it the whole page — wider than the screen. Only a single segment
	// longer than the full row width truncates (max-w-full).
	//
	// `trailing` (the expand chevron, when this row is a toggle) rides inside the
	// timestamp segment rather than at the end of the row: the row keeps `flex-1`
	// so the Retry variant's full-width button stays one big click target, which
	// would otherwise strand the chevron against the far right edge, detached from
	// everything it toggles.
	const summaryRow = (trailing?: ReactNode) => (
		<span className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0">
			<Link
				to="/projects/$projectId/agents/$agentId"
				params={agentLinkParams}
				onClick={(e) => e.stopPropagation()}
				className="text-xs text-text-2 whitespace-nowrap max-w-full truncate hover:text-text-1 hover:underline"
			>
				{agentLabel} run
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
			<span className="inline-flex items-center gap-1 min-w-0 max-w-full">
				{publicId ? (
					<CommentTimestampLink
						publicId={publicId}
						createdAt={createdAt}
						className="whitespace-nowrap"
					/>
				) : (
					<RelativeTime
						iso={createdAt}
						className="text-[11px] text-text-3 whitespace-nowrap min-w-0 truncate"
					/>
				)}
				{trailing}
			</span>
		</span>
	);

	const chevron = (
		<svg
			aria-hidden="true"
			className={`w-3 h-3 shrink-0 text-text-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
			viewBox="0 0 16 16"
			fill="currentColor"
		>
			<path d="M6 3l5 5-5 5V3z" />
		</svg>
	);

	// The expand/collapse toggle. `flex-1` is added only when a sibling Retry
	// button shares the row, so the whole header stays one click target; the
	// chevron rides with the timestamp either way (see summaryRow) rather than
	// being pushed to the stretched button's far edge.
	// `max-w-full` is load-bearing: a <button> shrink-wraps to its content's
	// max-content width (form controls ignore block-level auto-fill), so without
	// it the nowrap header segments widen the button — and the whole page —
	// past a narrow viewport instead of wrapping inside it.
	const expandToggle = (
		<button
			type="button"
			onClick={() => setExpanded((v) => !v)}
			aria-expanded={expanded}
			aria-controls={logRegionId}
			data-testid="run-comment-header"
			className={`flex max-w-full items-center min-h-[26px] min-w-0 text-left -mx-1 px-1 rounded-md hover:bg-surface-3 cursor-pointer${
				canRetry && taskId ? ' flex-1' : ''
			}`}
		>
			{summaryRow(chevron)}
		</button>
	);

	// The Conversation view's working row. A run in flight is the current state of
	// the task, not an event to file away, so it gets a row of its own that says
	// who is working and for how long, and opens onto the same live log.
	const workingRow = (
		<button
			type="button"
			onClick={() => setExpanded((v) => !v)}
			aria-expanded={expanded}
			aria-controls={logRegionId}
			data-testid="run-comment-working"
			className="mb-1.5 flex w-full min-w-0 items-center gap-2 rounded-md border border-live-soft-fg bg-live-soft px-3 py-2 text-left text-live-soft-fg cursor-pointer hover:brightness-[0.99] transition-[filter]"
		>
			<span
				aria-hidden="true"
				className={`inline-block w-2.5 h-2.5 shrink-0 rounded-full ${
					status === HeartbeatRunStatus.Queued ? 'bg-text-3' : 'bg-live animate-pulse'
				}`}
			/>
			<span className="min-w-0 flex-1 text-xs">
				<span className="font-semibold">{agentLabel}</span>{' '}
				{status === HeartbeatRunStatus.Queued
					? t('thread.working.queued')
					: t('thread.working.now')}
				{status === HeartbeatRunStatus.Queued && run?.queued_reason && (
					<span className="opacity-80"> - {run.queued_reason}</span>
				)}
			</span>
			{elapsed && (
				<span className="shrink-0 font-mono text-[11px] opacity-85" data-testid="working-elapsed">
					{elapsed}
				</span>
			)}
			<svg
				aria-hidden="true"
				className={`w-3 h-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
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
				(isActive && working ? (
					workingRow
				) : isActive ? (
					// Actively running/queued: the log is force-shown, so the header is a
					// static (non-collapsible) summary with no toggle.
					<div className="flex items-center min-h-[26px] min-w-0" data-testid="run-comment-header">
						{summaryRow()}
					</div>
				) : canRetry && taskId ? (
					<div className="flex items-center gap-1 min-w-0">
						{expandToggle}
						<RunRetryButton projectId={projectId} taskId={taskId} runId={runId} />
					</div>
				) : (
					// Completed or still loading: collapsed by default, expandable on click.
					expandToggle
				))}
			{inline && !isActive && errorSummary && (
				// Its own row rather than a segment of `summaryRow`, which is a wrapping
				// flex line tuned for narrow viewports that a reason of any length would
				// fight. Until this existed the reason was rendered in exactly one place
				// in the whole app - the run detail page - so a failed run in a thread
				// said only that it had failed.
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					aria-expanded={expanded}
					aria-controls={logRegionId}
					aria-label={t('comment.runErrorExpand')}
					data-testid="run-comment-error"
					className={`flex w-full min-w-0 items-start gap-1.5 rounded-md px-2 py-1 text-left text-[11.5px] ${
						errored ? 'bg-danger-soft text-danger-soft-fg' : 'bg-surface-3 text-text-2'
					}`}
				>
					<AlertTriangle className="mt-[3px] h-3 w-3 shrink-0" aria-hidden="true" />
					<span className="min-w-0 truncate">{errorSummary}</span>
				</button>
			)}
			{((isActive && !working) || expanded) && (
				<div id={logRegionId}>
					{run?.error && (
						// Mirrors the run detail page's block, so the two surfaces read the
						// same rather than the reason living in one of them.
						<div className="mb-2" data-testid="run-comment-error-full">
							<div className="mb-1 text-[11px] uppercase tracking-wider text-text-3">
								{t('comment.runError')}
							</div>
							<pre className="max-h-[140px] overflow-auto whitespace-pre-wrap rounded-lg bg-danger-soft p-3 font-mono text-xs text-danger-soft-fg">
								{run.error}
							</pre>
						</div>
					)}
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
								<span className="hidden sm:inline">
									{agentLabel} - {runStatusLabel(status)}
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
							Created task {task.identifier} - {task.title}
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
							{/* A project-scoped skill lives on the owning project's Skills page;
							    a global skill is managed on /settings/skills. */}
							{skill.project_slug ? (
								<Link
									to="/projects/$projectId/skills"
									params={{ projectId: skill.project_slug }}
									className="text-info-soft-fg hover:underline"
								>
									{skill.created ? 'Added' : 'Updated'} skill {skill.name}
								</Link>
							) : (
								<Link to="/settings/skills" className="text-info-soft-fg hover:underline">
									{skill.created ? 'Added' : 'Updated'} skill {skill.name}
								</Link>
							)}
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
