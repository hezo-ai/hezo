import { AgentAdminStatus } from '@hezo/shared';
import { createFileRoute, Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
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

	if (isLoading || !agent) return <div className="text-text-muted">Loading...</div>;

	return (
		<div className="max-w-3xl">
			<Link
				to="/projects/$projectId/agents"
				params={{ projectId }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Team
			</Link>

			<div className="flex items-center gap-3 mb-4">
				<h1
					className={`text-lg font-semibold${agent.admin_status === AgentAdminStatus.Disabled ? ' text-text-muted' : ''}`}
				>
					{agent.title}
					{agent.admin_status === AgentAdminStatus.Disabled ? ' (disabled)' : ''}
				</h1>
				<Badge color={agentRuntimeStatusMeta(agent.runtime_status).color}>
					{agentRuntimeStatusMeta(agent.runtime_status).label}
				</Badge>
			</div>

			<div
				data-testid="agent-summary"
				className="rounded-lg border border-border-subtle bg-bg-subtle p-4 text-sm leading-relaxed text-text mb-6"
			>
				<ExpandableText
					text={agent.summary ?? ''}
					placeholder={<span className="italic text-text-muted">Description being generated…</span>}
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
									? 'border-primary text-text'
									: 'border-transparent text-text-muted hover:text-text hover:border-border-hover'
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
