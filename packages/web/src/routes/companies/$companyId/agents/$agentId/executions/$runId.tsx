import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { Badge } from '../../../../../../components/ui/badge';
import { useHeartbeatRun } from '../../../../../../hooks/use-heartbeat-runs';
import { useRunLogs } from '../../../../../../hooks/use-run-logs';

function formatDuration(startedAt: string, finishedAt: string | null): string {
	if (!finishedAt) return 'In progress...';
	const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

function statusColor(status: string): string {
	switch (status) {
		case 'succeeded':
			return 'green';
		case 'failed':
		case 'timed_out':
			return 'red';
		case 'running':
			return 'yellow';
		case 'cancelled':
			return 'neutral';
		default:
			return 'neutral';
	}
}

function ExecutionDetailPage() {
	const { companyId, agentId, runId } = Route.useParams();
	const { data: run, isLoading } = useHeartbeatRun(companyId, agentId, runId);

	const isActive = run?.status === 'running' || run?.status === 'queued';
	const { lines } = useRunLogs(run?.project_id ?? null, run?.id ?? null, run?.log_text, isActive);

	const logBoxRef = useRef<HTMLPreElement>(null);
	const lastLineCount = useRef(0);

	useEffect(() => {
		const box = logBoxRef.current;
		if (!box) return;
		const atBottom =
			box.scrollHeight - box.scrollTop - box.clientHeight < 80 ||
			lines.length === lastLineCount.current;
		if (atBottom) {
			box.scrollTop = box.scrollHeight;
		}
		lastLineCount.current = lines.length;
	}, [lines]);

	const displayedCommand = useMemo(
		() => run?.invocation_command ?? null,
		[run?.invocation_command],
	);

	if (isLoading) return <div className="text-text-muted text-sm">Loading...</div>;
	if (!run) return <div className="text-text-muted text-sm">Run not found.</div>;

	return (
		<div>
			<Link
				to="/companies/$companyId/agents/$agentId/executions"
				params={{ companyId, agentId }}
				className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3 h-3" /> Executions
			</Link>

			<div className="flex items-center gap-2 mb-4">
				<h2 className="text-sm font-medium">Run {run.id.slice(0, 8)}</h2>
				<Badge color={statusColor(run.status) as 'green'}>{run.status}</Badge>
			</div>

			<div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
				<div className="rounded-lg border border-border-subtle bg-bg p-3">
					<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">Duration</div>
					<div className="text-sm font-medium">
						{formatDuration(run.started_at, run.finished_at)}
					</div>
				</div>

				<div className="rounded-lg border border-border-subtle bg-bg p-3">
					<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">Started</div>
					<div className="text-sm">{new Date(run.started_at).toLocaleString()}</div>
				</div>

				{run.finished_at && (
					<div className="rounded-lg border border-border-subtle bg-bg p-3">
						<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">
							Finished
						</div>
						<div className="text-sm">{new Date(run.finished_at).toLocaleString()}</div>
					</div>
				)}

				{run.exit_code !== null && (
					<div className="rounded-lg border border-border-subtle bg-bg p-3">
						<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">
							Exit Code
						</div>
						<div className={`text-sm font-mono ${run.exit_code !== 0 ? 'text-accent-red' : ''}`}>
							{run.exit_code}
						</div>
					</div>
				)}

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

			{run.issue_identifier && (
				<div className="mb-4 text-xs text-text-muted">
					Issue: <span className="font-mono text-text">{run.issue_identifier}</span>
					{run.issue_title && <span className="ml-1">{run.issue_title}</span>}
				</div>
			)}

			{displayedCommand && (
				<div className="mb-3">
					<div className="text-[11px] text-text-subtle uppercase tracking-wider mb-1">
						Invocation
					</div>
					<pre className="text-xs font-mono bg-bg-muted rounded-lg p-3 overflow-x-auto whitespace-pre-wrap text-text-muted">
						{displayedCommand}
					</pre>
					{run.working_dir && (
						<div className="mt-1 text-[11px] text-text-subtle">
							cwd: <span className="font-mono">{run.working_dir}</span>
						</div>
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
				<div className="flex items-center justify-between mb-1">
					<div className="text-[11px] text-text-subtle uppercase tracking-wider">
						Log {isActive && <span className="ml-1 text-accent-yellow">(live)</span>}
					</div>
					<div className="text-[11px] text-text-subtle">{lines.length} lines</div>
				</div>
				<pre
					ref={logBoxRef}
					data-testid="run-log"
					className="text-xs font-mono bg-bg-muted rounded-lg p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap text-text-muted"
				>
					{lines.length === 0
						? isActive
							? 'Waiting for log output...'
							: 'No output captured.'
						: lines.map((line) => (
								<div
									key={line.id}
									className={line.stream === 'stderr' ? 'text-accent-red-text' : ''}
								>
									{line.text}
								</div>
							))}
				</pre>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/agents/$agentId/executions/$runId')({
	component: ExecutionDetailPage,
});
