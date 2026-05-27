import { createFileRoute, Link } from '@tanstack/react-router';
import { Badge } from '../../../../../../components/ui/badge';
import { Tooltip } from '../../../../../../components/ui/tooltip';
import { useElapsedDuration } from '../../../../../../hooks/use-elapsed-duration';
import { type HeartbeatRun, useHeartbeatRuns } from '../../../../../../hooks/use-heartbeat-runs';
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

function ExecutionRow({
	run,
	teamId,
	agentId,
}: {
	run: HeartbeatRun;
	teamId: string;
	agentId: string;
}) {
	const elapsed = useElapsedDuration(run.started_at ?? '', run.finished_at);
	const trigger = formatTriggerReason(run, teamId);

	return (
		<Link
			to="/teams/$teamId/agents/$agentId/executions/$runId"
			params={{ teamId, agentId, runId: run.id }}
			className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg px-3 py-2.5 text-xs hover:bg-bg-subtle transition-colors"
		>
			<Badge color={statusColor(run.status) as 'green'}>
				{(run.status === 'running' || run.status === 'queued') && (
					<span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse mr-1" />
				)}
				{run.status}
			</Badge>

			{run.task_identifier && (
				<span className="text-text-muted font-mono">
					{run.task_identifier}
					{run.task_title && <span className="font-sans ml-1.5 text-text">{run.task_title}</span>}
				</span>
			)}

			<Tooltip content={trigger.text}>
				<span className="text-text-subtle truncate">{trigger.text}</span>
			</Tooltip>

			<span className="text-text-muted ml-auto whitespace-nowrap">
				{run.started_at ? new Date(run.started_at).toLocaleString() : 'queued'}
			</span>

			<span className="text-text-subtle whitespace-nowrap">{elapsed}</span>

			{run.cost_cents != null && run.cost_cents > 0 && (
				<span className="text-text-subtle whitespace-nowrap">
					${(run.cost_cents / 100).toFixed(2)}
				</span>
			)}

			{run.exit_code !== null && run.exit_code !== 0 && (
				<span className="text-accent-red whitespace-nowrap">exit: {run.exit_code}</span>
			)}
		</Link>
	);
}

function ExecutionListPage() {
	const { teamId, agentId } = Route.useParams();
	const { data: runs, isLoading } = useHeartbeatRuns(teamId, agentId);

	if (isLoading) return <div className="text-text-muted text-sm">Loading executions...</div>;

	if (!runs || runs.length === 0) {
		return <div className="text-text-muted text-sm py-4">No executions yet.</div>;
	}

	return (
		<div className="flex flex-col gap-1">
			{runs.map((run) => (
				<ExecutionRow key={run.id} run={run} teamId={teamId} agentId={agentId} />
			))}
		</div>
	);
}

export const Route = createFileRoute('/teams/$teamId/agents/$agentId/executions/')({
	component: ExecutionListPage,
});
