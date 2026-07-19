import { INSTANCE_AGENT_SLUGS } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { InfiniteScrollSentinel } from '../../../../../../components/infinite-scroll-sentinel';
import { Badge } from '../../../../../../components/ui/badge';
import { Tooltip } from '../../../../../../components/ui/tooltip';
import { useAgent } from '../../../../../../hooks/use-agents';
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
	projectId,
	agentId,
	isInstanceAgent,
}: {
	run: HeartbeatRun;
	projectId: string;
	agentId: string;
	isInstanceAgent: boolean;
}) {
	const elapsed = useElapsedDuration(run.started_at ?? '', run.finished_at);
	const trigger = formatTriggerReason(run, projectId);
	const projectLabel = run.project_name ?? run.project_slug;

	return (
		<Link
			to="/projects/$projectId/agents/$agentId/executions/$runId"
			params={{ projectId, agentId, runId: run.id }}
			data-testid="execution-row"
			className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-3 py-2.5 text-xs hover:bg-surface-2 transition-colors"
		>
			<Badge color={statusColor(run.status) as 'green'}>
				{(run.status === 'running' || run.status === 'queued') && (
					<span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse mr-1" />
				)}
				{run.status}
			</Badge>

			{run.task_identifier && (
				<span className="text-text-2 font-mono">
					{run.task_identifier}
					{run.task_title && <span className="font-sans ml-1.5 text-text-1">{run.task_title}</span>}
					{isInstanceAgent && projectLabel && (
						<span data-testid="run-row-project" className="font-sans ml-1.5 text-text-3">
							· {projectLabel}
						</span>
					)}
				</span>
			)}

			<Tooltip content={trigger.text}>
				<span className="text-text-3 truncate">{trigger.text}</span>
			</Tooltip>

			<span className="text-text-2 ml-auto whitespace-nowrap">
				{run.started_at ? new Date(run.started_at).toLocaleString() : 'queued'}
			</span>

			<span className="text-text-3 whitespace-nowrap">{elapsed}</span>

			{run.cost_cents != null && run.cost_cents > 0 && (
				<span className="text-text-3 whitespace-nowrap">${(run.cost_cents / 100).toFixed(2)}</span>
			)}

			{run.exit_code !== null && run.exit_code !== 0 && (
				<span className="text-danger whitespace-nowrap">exit: {run.exit_code}</span>
			)}
		</Link>
	);
}

function ExecutionListPage() {
	const { projectId, agentId } = Route.useParams();
	const {
		data: runPages,
		isLoading,
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	} = useHeartbeatRuns(projectId, agentId);
	const { data: agent } = useAgent(projectId, agentId);

	// Flatten the accumulated pages, deduping by id: offset pagination + the 10s
	// poll can transiently overlap a page boundary when a new run prepends.
	const runs = useMemo(() => {
		const seen = new Set<string>();
		const out: HeartbeatRun[] = [];
		for (const run of runPages?.pages.flatMap((p) => p.data) ?? []) {
			if (seen.has(run.id)) continue;
			seen.add(run.id);
			out.push(run);
		}
		return out;
	}, [runPages]);

	// CEO/Coach runs span many projects (the list is member-scoped), so show each
	// row's project. Gate on the agent slug — see the run-detail page for why.
	const isInstanceAgent =
		!!agent && (INSTANCE_AGENT_SLUGS as readonly string[]).includes(agent.slug);

	if (isLoading) return <div className="text-text-2 text-sm">Loading executions...</div>;

	if (runs.length === 0) {
		return <div className="text-text-2 text-sm py-4">No executions yet.</div>;
	}

	return (
		<div className="flex flex-col gap-1">
			{runs.map((run) => (
				<ExecutionRow
					key={run.id}
					run={run}
					projectId={projectId}
					agentId={agentId}
					isInstanceAgent={isInstanceAgent}
				/>
			))}
			<InfiniteScrollSentinel
				hasNextPage={hasNextPage}
				isFetchingNextPage={isFetchingNextPage}
				onLoadMore={fetchNextPage}
				testId="executions"
			/>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/agents/$agentId/executions/')({
	component: ExecutionListPage,
});
