import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { LogViewer } from '../../../../../../components/log-viewer';
import { TerminateRunButton } from '../../../../../../components/terminate-run-button';
import { Badge } from '../../../../../../components/ui/badge';
import { useElapsedDuration } from '../../../../../../hooks/use-elapsed-duration';
import { getRunWaitingMessage, useHeartbeatRun } from '../../../../../../hooks/use-heartbeat-runs';
import { useRunLogs } from '../../../../../../hooks/use-run-logs';
import { formatTriggerReason } from '../../../../../../lib/run-trigger';

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
	const { teamId, agentId, runId } = Route.useParams();
	const { data: run, isLoading } = useHeartbeatRun(teamId, agentId, runId);

	const isActive = run?.status === 'running' || run?.status === 'queued';
	const { lines } = useRunLogs(run?.project_id ?? null, run?.id ?? null, run?.log_text, isActive);

	const [invocationExpanded, setInvocationExpanded] = useState(false);

	const displayedCommand = useMemo(
		() => run?.invocation_command ?? null,
		[run?.invocation_command],
	);

	const elapsed = useElapsedDuration(run?.started_at ?? '', run?.finished_at ?? null);
	const elapsedDisplay = run?.started_at ? elapsed : '—';

	if (isLoading) return <div className="text-text-muted text-sm">Loading...</div>;
	if (!run) return <div className="text-text-muted text-sm">Run not found.</div>;

	return (
		<div>
			<Link
				to="/teams/$teamId/agents/$agentId/executions"
				params={{ teamId, agentId }}
				className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3 h-3" /> Executions
			</Link>

			<div className="flex items-center gap-2 mb-4">
				<h2 className="text-sm font-medium">Run {run.id.slice(0, 8)}</h2>
				<Badge color={statusColor(run.status) as 'green'}>{run.status}</Badge>
				<div className="ml-auto">
					<TerminateRunButton
						teamId={teamId}
						agentId={agentId}
						runId={runId}
						status={run.status}
						taskId={run.task_id}
						variant="standalone"
					/>
				</div>
			</div>

			{(() => {
				const trigger = formatTriggerReason(run, teamId);
				return (
					<div className="mb-4 text-xs" data-testid="run-trigger-reason">
						<span className="text-text-subtle uppercase tracking-wider mr-2">Triggered by</span>
						{trigger.href ? (
							<a
								href={trigger.href}
								className="text-text hover:underline"
								data-testid="run-trigger-link"
							>
								{trigger.text}
							</a>
						) : (
							<span className="text-text">{trigger.text}</span>
						)}
					</div>
				);
			})()}

			<div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
				<div className="rounded-lg border border-border-subtle bg-bg p-3">
					<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">Duration</div>
					<div className="text-sm font-medium">{elapsedDisplay}</div>
				</div>

				<div className="rounded-lg border border-border-subtle bg-bg p-3">
					<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">When</div>
					<div className="text-sm">
						{run.started_at ? (
							<>
								{new Date(run.started_at).toLocaleString()}
								{run.finished_at && (
									<>
										<span className="text-text-subtle"> → </span>
										{new Date(run.finished_at).toLocaleString()}
									</>
								)}
							</>
						) : (
							<span className="text-text-subtle">Waiting to start…</span>
						)}
					</div>
				</div>

				<div className="rounded-lg border border-border-subtle bg-bg p-3">
					<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">Tokens</div>
					<div className="text-sm">
						{run.input_tokens.toLocaleString()} in / {run.output_tokens.toLocaleString()} out
					</div>
				</div>

				{run.cost_cents != null && run.cost_cents > 0 && (
					<div className="rounded-lg border border-border-subtle bg-bg p-3">
						<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">Cost</div>
						<div className="text-sm font-medium">${(run.cost_cents / 100).toFixed(2)}</div>
					</div>
				)}
			</div>

			{run.task_identifier &&
				(run.task_id ? (
					run.project_slug ? (
						<Link
							to="/teams/$teamId/projects/$projectId/tasks/$taskId"
							params={{
								teamId,
								projectId: run.project_slug,
								taskId: run.task_identifier.toLowerCase(),
							}}
							{...(run.run_comment_id ? { hash: `comment-${run.run_comment_id}` } : {})}
							className="mb-4 inline-flex items-baseline gap-1 text-xs text-text-muted hover:text-text"
						>
							<span>Task:</span>
							<span className="font-mono text-text">{run.task_identifier}</span>
							{run.task_title && <span>{run.task_title}</span>}
						</Link>
					) : (
						<Link
							to="/teams/$teamId/tasks/$taskId"
							params={{ teamId, taskId: run.task_identifier.toLowerCase() }}
							{...(run.run_comment_id ? { hash: `comment-${run.run_comment_id}` } : {})}
							className="mb-4 inline-flex items-baseline gap-1 text-xs text-text-muted hover:text-text"
						>
							<span>Task:</span>
							<span className="font-mono text-text">{run.task_identifier}</span>
							{run.task_title && <span>{run.task_title}</span>}
						</Link>
					)
				) : (
					<div className="mb-4 text-xs text-text-muted">
						Task: <span className="font-mono text-text">{run.task_identifier}</span>
						{run.task_title && <span className="ml-1">{run.task_title}</span>}
					</div>
				))}

			{displayedCommand && (
				<div className="mb-3">
					<button
						type="button"
						onClick={() => setInvocationExpanded(!invocationExpanded)}
						className="flex items-center gap-1.5 text-[11px] text-text-subtle uppercase tracking-wider hover:text-text-muted mb-1"
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
								className="text-xs font-mono bg-bg-muted rounded-lg p-3 overflow-x-auto whitespace-pre-wrap text-text-muted"
							>
								{displayedCommand}
							</pre>
							{run.working_dir && (
								<div className="mt-1 text-[11px] text-text-subtle">
									cwd: <span className="font-mono">{run.working_dir}</span>
								</div>
							)}
						</>
					)}
				</div>
			)}

			{run.error && (
				<div className="mb-4">
					<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">Error</div>
					<pre className="text-xs font-mono bg-accent-red-bg text-accent-red-text rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
						{run.error}
					</pre>
				</div>
			)}

			<div className="mb-4">
				<LogViewer
					lines={lines}
					emptyState={isActive ? getRunWaitingMessage(run.status) : 'No output captured.'}
					liveLabel={isActive ? <span className="text-accent-amber">(live)</span> : null}
					heightClassName="max-h-[60vh]"
					testId="run-log"
					headerActionLeading={
						<TerminateRunButton
							teamId={teamId}
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

export const Route = createFileRoute('/teams/$teamId/agents/$agentId/executions/$runId')({
	component: ExecutionDetailPage,
});
