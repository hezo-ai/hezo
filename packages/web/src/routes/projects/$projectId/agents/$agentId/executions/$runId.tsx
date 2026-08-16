import { INSTANCE_AGENT_SLUGS, isRunOutcomeFilter, RunOutcomeFilter } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { format } from 'date-fns';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { LogViewer } from '../../../../../../components/log-viewer';
import { TerminateRunButton } from '../../../../../../components/terminate-run-button';
import { Badge } from '../../../../../../components/ui/badge';
import { Tooltip } from '../../../../../../components/ui/tooltip';
import { useAgent } from '../../../../../../hooks/use-agents';
import { useElapsedDuration } from '../../../../../../hooks/use-elapsed-duration';
import { getRunWaitingMessage, useHeartbeatRun } from '../../../../../../hooks/use-heartbeat-runs';
import { useRunLogs } from '../../../../../../hooks/use-run-logs';
import { formatTriggerReason } from '../../../../../../lib/run-trigger';

function formatTimeRange(
	startedAt: string | null,
	finishedAt: string | null,
): { compact: string; full: string } | null {
	if (!startedAt) return null;
	const start = new Date(startedAt);
	const end = finishedAt ? new Date(finishedAt) : null;
	const sameDay = end && start.toDateString() === end.toDateString();
	const compactStart = format(start, 'MMM d, HH:mm:ss');
	const compact = !end
		? `Started ${compactStart}`
		: sameDay
			? `${compactStart} → ${format(end, 'HH:mm:ss')}`
			: `${compactStart} → ${format(end, 'MMM d, HH:mm:ss')}`;
	const full = !end
		? `Started ${start.toLocaleString()}`
		: `${start.toLocaleString()} → ${end.toLocaleString()}`;
	return { compact, full };
}

function statusColor(status: string): string {
	switch (status) {
		case 'succeeded':
			return 'green';
		case 'failed':
		case 'timed_out':
			return 'red';
		case 'running':
		case 'queued':
			return 'yellow';
		case 'cancelled':
			return 'neutral';
		default:
			return 'neutral';
	}
}

function ExecutionDetailPage() {
	const { projectId, agentId, runId } = Route.useParams();
	const { filter } = Route.useSearch();
	const { data: run, isLoading } = useHeartbeatRun(projectId, agentId, runId);
	const { data: agent } = useAgent(projectId, agentId);

	// CEO/Coach run across every project, so their pages surface which project a
	// task lives in. Gate on the agent slug (not the context-dependent
	// `is_instance` flag, which is false when they're viewed under HQ's own roster).
	const isInstanceAgent =
		!!agent && (INSTANCE_AGENT_SLUGS as readonly string[]).includes(agent.slug);

	const isActive = run?.status === 'running' || run?.status === 'queued';
	const { lines } = useRunLogs(run?.project_id ?? null, run?.id ?? null, run?.log_text, isActive);

	const [invocationExpanded, setInvocationExpanded] = useState(false);

	const displayedCommand = useMemo(
		() => run?.invocation_command ?? null,
		[run?.invocation_command],
	);

	const elapsed = useElapsedDuration(run?.started_at ?? '', run?.finished_at ?? null);
	const elapsedDisplay = run?.started_at ? elapsed : '—';

	if (isLoading) return <div className="text-text-2 text-sm">Loading...</div>;
	if (!run) return <div className="text-text-2 text-sm">Run not found.</div>;

	const projectLabel = run.project_name ?? run.project_slug;
	const taskLineInner = (
		<>
			<span className="text-text-3">Task:</span>
			<span className="font-mono font-semibold text-text-1">{run.task_identifier}</span>
			{run.task_title && <span className="font-medium text-text-1">{run.task_title}</span>}
			{isInstanceAgent && projectLabel && (
				<span data-testid="run-task-project" className="text-text-3">
					· {projectLabel}
				</span>
			)}
		</>
	);

	const taskBlock = run.task_identifier ? (
		<div className="mb-4" data-testid="run-task">
			{run.task_id ? (
				<Link
					to="/projects/$projectId/tasks/$taskId"
					params={{
						projectId: run.project_slug ?? projectId,
						taskId: run.task_identifier.toLowerCase(),
					}}
					{...(run.run_comment_public_id ? { hash: `comment-${run.run_comment_public_id}` } : {})}
					className="inline-flex items-baseline gap-2 flex-wrap text-sm text-text-2 hover:underline"
				>
					{taskLineInner}
				</Link>
			) : (
				<div className="inline-flex items-baseline gap-2 flex-wrap text-sm text-text-2">
					{taskLineInner}
				</div>
			)}
		</div>
	) : null;

	return (
		<div>
			{/* Carries the filter the reader arrived with, so going back returns them
			    to the view they left rather than to the default one - which need not
			    contain the run they were just looking at. Absent (a deep link, or a
			    run reached from a goal or a comment) falls through to All, which
			    always contains it. */}
			<Link
				to="/projects/$projectId/agents/$agentId/executions"
				params={{ projectId, agentId }}
				search={filter ? { filter } : {}}
				data-testid="run-back-link"
				className="inline-flex items-center gap-1 text-xs text-text-2 hover:text-text-1 mb-4"
			>
				<ArrowLeft className="w-3 h-3" /> Executions
			</Link>

			<div className="flex items-center gap-2 mb-4">
				<h2 className="text-sm font-medium">Run {run.id.slice(0, 8)}</h2>
				<Badge color={statusColor(run.status) as 'green'}>{run.status}</Badge>
			</div>

			{taskBlock}

			{(() => {
				const trigger = formatTriggerReason(run, projectId);
				return (
					<div className="mb-4 text-xs" data-testid="run-trigger-reason">
						<span className="text-text-3 uppercase tracking-wider mr-2">Triggered by</span>
						{trigger.href ? (
							<a
								href={trigger.href}
								className="text-text-1 hover:underline"
								data-testid="run-trigger-link"
							>
								{trigger.text}
							</a>
						) : (
							<span className="text-text-1">{trigger.text}</span>
						)}
					</div>
				);
			})()}

			{(() => {
				const range = formatTimeRange(run.started_at, run.finished_at);
				return (
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
						<div className="rounded-lg border border-border-subtle bg-surface p-3">
							<div className="text-[11px] text-text-3 uppercase tracking-wider mb-1">Timing</div>
							<div className="flex items-baseline gap-2 flex-wrap">
								<span data-testid="run-duration" className="text-sm font-medium tabular-nums">
									{elapsedDisplay}
								</span>
								{range ? (
									<Tooltip content={range.full}>
										<span className="text-xs text-text-3 whitespace-nowrap tabular-nums">
											{range.compact}
										</span>
									</Tooltip>
								) : (
									<span className="text-xs text-text-3">Waiting to start…</span>
								)}
							</div>
						</div>

						{!isActive && (
							<div className="rounded-lg border border-border-subtle bg-surface p-3">
								<div className="text-[11px] text-text-3 uppercase tracking-wider mb-1">Usage</div>
								<div className="flex items-baseline gap-2 flex-wrap">
									{run.cost_cents != null && run.cost_cents > 0 && (
										<span className="text-sm font-medium tabular-nums">
											{run.usage_partial ? '~' : ''}${(run.cost_cents / 100).toFixed(2)}
										</span>
									)}
									<span className="text-xs text-text-3 whitespace-nowrap tabular-nums">
										{run.usage_partial ? '~' : ''}
										{run.input_tokens.toLocaleString()} in · {run.output_tokens.toLocaleString()}{' '}
										out tokens
									</span>
									{run.usage_partial && (
										<Tooltip content="The run was interrupted before it finished, so this usage is a partial snapshot of what it consumed.">
											<span className="text-[11px] font-medium text-warning whitespace-nowrap">
												interrupted
											</span>
										</Tooltip>
									)}
								</div>
							</div>
						)}
					</div>
				);
			})()}

			{displayedCommand && (
				<div className="mb-3">
					<button
						type="button"
						onClick={() => setInvocationExpanded(!invocationExpanded)}
						className="flex items-center gap-1.5 text-[11px] text-text-3 uppercase tracking-wider hover:text-text-2 mb-1"
					>
						{invocationExpanded ? (
							<ChevronDown className="w-3 h-3" />
						) : (
							<ChevronRight className="w-3 h-3" />
						)}
						Invocation
					</button>
					{invocationExpanded && (
						<>
							<pre
								data-testid="run-invocation-body"
								className="text-xs font-mono bg-surface-3 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap text-text-2"
							>
								{displayedCommand}
							</pre>
							{run.working_dir && (
								<div className="mt-1 text-[11px] text-text-3">
									cwd: <span className="font-mono">{run.working_dir}</span>
								</div>
							)}
						</>
					)}
				</div>
			)}

			{run.error && (
				<div className="mb-4">
					<div className="text-[11px] text-text-3 uppercase tracking-wider mb-1">Error</div>
					<pre className="text-xs font-mono bg-danger-soft text-danger-soft-fg rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
						{run.error}
					</pre>
				</div>
			)}

			<div className="mb-4">
				<LogViewer
					lines={lines}
					formattable
					projectId={projectId}
					projectSlug={run.project_slug ?? undefined}
					commentRefTask={
						run.task_identifier
							? {
									identifier: run.task_identifier,
									title: run.task_title ?? '',
									projectSlug: run.project_slug ?? projectId,
								}
							: undefined
					}
					emptyState={
						isActive ? getRunWaitingMessage(run.status, run.queued_reason) : 'No output captured.'
					}
					liveLabel={isActive ? <span className="text-warning">(live)</span> : null}
					heightClassName="max-h-[60vh]"
					testId="run-log"
					headerActionLeading={
						<TerminateRunButton
							projectId={projectId}
							agentId={agentId}
							runId={runId}
							status={run.status}
							taskId={run.task_id}
						/>
					}
				/>
			</div>
		</div>
	);
}

interface ExecutionDetailSearch {
	/**
	 * The list filter the reader came from, carried only so the back link can
	 * restore it. Absent means they arrived from somewhere with no view to return
	 * to, and back goes to the default All.
	 */
	filter?: RunOutcomeFilter;
}

export const Route = createFileRoute('/projects/$projectId/agents/$agentId/executions/$runId')({
	// Mirrors the list route: the default is dropped rather than written, so one
	// view cannot be addressed two ways.
	validateSearch: (search: Record<string, unknown>): ExecutionDetailSearch => ({
		filter:
			isRunOutcomeFilter(search.filter) && search.filter !== RunOutcomeFilter.All
				? search.filter
				: undefined,
	}),
	component: ExecutionDetailPage,
});
