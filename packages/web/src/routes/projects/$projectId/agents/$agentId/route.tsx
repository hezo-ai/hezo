import { AgentAdminStatus } from '@hezo/shared';
import { createFileRoute, Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { NextHeartbeatIndicator } from '../../../../../components/next-heartbeat-indicator';
import { Badge } from '../../../../../components/ui/badge';
import { ExpandableText } from '../../../../../components/ui/expandable-text';
import { useAgent } from '../../../../../hooks/use-agents';
import { agentRuntimeStatusMeta } from '../../../../../lib/status-meta';

const tabs = [
	{
		label: 'Executions',
		to: '/projects/$projectId/agents/$agentId/executions' as const,
	},
	{
		label: 'Settings',
		to: '/projects/$projectId/agents/$agentId/settings' as const,
	},
];

function AgentLayout() {
	const { projectId, agentId } = Route.useParams();
	const { data: agent, isLoading } = useAgent(projectId, agentId);
	const matchRoute = useMatchRoute();
	const params = { projectId, agentId };

	if (isLoading || !agent) return <div className="text-text-2">Loading...</div>;

	return (
		<div className="max-w-3xl">
			<Link
				to="/projects/$projectId/agents"
				params={{ projectId }}
				className="inline-flex items-center gap-1 text-sm text-text-2 hover:text-text-1 mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Team
			</Link>

			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-4">
				<h1
					className={`text-lg font-semibold${agent.admin_status === AgentAdminStatus.Disabled ? ' text-text-2' : ''}`}
				>
					{agent.title}
					{agent.admin_status === AgentAdminStatus.Disabled ? ' (disabled)' : ''}
				</h1>
				<Badge color={agentRuntimeStatusMeta(agent.runtime_status).color}>
					{agentRuntimeStatusMeta(agent.runtime_status).label}
				</Badge>
				<NextHeartbeatIndicator
					nextHeartbeatAt={agent.next_heartbeat_at}
					hasActionableWork={agent.has_actionable_work}
					className="w-full sm:w-auto sm:ml-auto"
				/>
			</div>

			<div
				data-testid="agent-summary"
				className="rounded-lg border border-border-subtle bg-surface-2 p-4 text-sm leading-relaxed text-text-1 mb-6"
			>
				<ExpandableText
					text={agent.summary ?? ''}
					placeholder={<span className="italic text-text-2">Description being generated…</span>}
				/>
			</div>

			<div className="flex gap-1 border-b border-border mb-6 mt-6">
				{tabs.map((tab) => {
					const isActive = matchRoute({ to: tab.to, params, fuzzy: true });
					return (
						<Link
							key={tab.to}
							to={tab.to}
							params={params}
							className={`px-3 py-2 text-[13px] font-medium border-b-2 transition-colors -mb-px ${
								isActive
									? 'border-inverse text-text-1'
									: 'border-transparent text-text-2 hover:text-text-1 hover:border-border-strong'
							}`}
						>
							{tab.label}
						</Link>
					);
				})}
			</div>

			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/agents/$agentId')({
	component: AgentLayout,
});
