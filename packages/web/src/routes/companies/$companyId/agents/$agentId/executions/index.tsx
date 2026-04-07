import { createFileRoute, Link } from '@tanstack/react-router';
import { Badge } from '../../../../../../components/ui/badge';
import { useHeartbeatRuns } from '../../../../../../hooks/use-heartbeat-runs';

function formatDuration(startedAt: string, finishedAt: string | null): string {
	if (!finishedAt) return '...';
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

function ExecutionListPage() {
	const { companyId, agentId } = Route.useParams();
	const { data: runs, isLoading } = useHeartbeatRuns(companyId, agentId);

	if (isLoading) return <div className="text-text-muted text-sm">Loading executions...</div>;

	if (!runs || runs.length === 0) {
		return <div className="text-text-muted text-sm py-4">No executions yet.</div>;
	}

	return (
		<div className="flex flex-col gap-1">
			{runs.map((run) => (
				<Link
					key={run.id}
					to="/companies/$companyId/agents/$agentId/executions/$runId"
					params={{ companyId, agentId, runId: run.id }}
					className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg px-3 py-2.5 text-xs hover:bg-bg-subtle transition-colors"
				>
					<Badge color={statusColor(run.status) as 'green'}>
						{run.status === 'running' && (
							<span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse mr-1" />
						)}
						{run.status}
					</Badge>

					{run.issue_identifier && (
						<span className="text-text-muted font-mono">
							{run.issue_identifier}
							{run.issue_title && (
								<span className="font-sans ml-1.5 text-text">{run.issue_title}</span>
							)}
						</span>
					)}

					<span className="text-text-muted ml-auto whitespace-nowrap">
						{new Date(run.started_at).toLocaleString()}
					</span>

					<span className="text-text-subtle whitespace-nowrap">
						{formatDuration(run.started_at, run.finished_at)}
					</span>

					{run.cost_cents != null && run.cost_cents > 0 && (
						<span className="text-text-subtle whitespace-nowrap">
							${(run.cost_cents / 100).toFixed(2)}
						</span>
					)}

					{run.exit_code !== null && run.exit_code !== 0 && (
						<span className="text-accent-red whitespace-nowrap">exit: {run.exit_code}</span>
					)}
				</Link>
			))}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/agents/$agentId/executions/')({
	component: ExecutionListPage,
});
