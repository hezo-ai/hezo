import { AgentAdminStatus, AgentRuntimeStatus } from '@hezo/shared';
import { createFileRoute, Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import { ArrowLeft, Power, PowerOff } from 'lucide-react';
import { Badge } from '../../../../../components/ui/badge';
import { Button } from '../../../../../components/ui/button';
import { useAgent, useDisableAgent, useEnableAgent } from '../../../../../hooks/use-agents';

const RUNTIME_BADGE: Record<string, { color: string; label: string }> = {
	[AgentRuntimeStatus.Active]: { color: 'green', label: 'Running' },
	[AgentRuntimeStatus.Paused]: { color: 'yellow', label: 'Paused' },
	[AgentRuntimeStatus.Idle]: { color: 'neutral', label: 'Idle' },
};

const tabs = [
	{
		label: 'Executions',
		to: '/companies/$companyId/agents/$agentId/executions' as const,
	},
	{
		label: 'Settings',
		to: '/companies/$companyId/agents/$agentId/settings' as const,
	},
];

function AgentLayout() {
	const { companyId, agentId } = Route.useParams();
	const { data: agent, isLoading } = useAgent(companyId, agentId);
	const disableAgent = useDisableAgent(companyId);
	const enableAgent = useEnableAgent(companyId);
	const matchRoute = useMatchRoute();
	const params = { companyId, agentId };

	if (isLoading || !agent) return <div className="p-6 text-text-muted">Loading...</div>;

	return (
		<div className="p-6 max-w-3xl">
			<Link
				to="/companies/$companyId/agents"
				params={{ companyId }}
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
				<Badge
					color={
						(RUNTIME_BADGE[agent.runtime_status] ?? RUNTIME_BADGE[AgentRuntimeStatus.Idle])
							.color as 'gray'
					}
				>
					{(RUNTIME_BADGE[agent.runtime_status] ?? RUNTIME_BADGE[AgentRuntimeStatus.Idle]).label}
				</Badge>
			</div>

			<div className="flex gap-2 mb-6">
				{agent.admin_status === AgentAdminStatus.Enabled && (
					<Button variant="secondary" size="sm" onClick={() => disableAgent.mutate(agentId)}>
						<PowerOff className="w-3 h-3" /> Disable
					</Button>
				)}
				{agent.admin_status === AgentAdminStatus.Disabled && (
					<Button variant="secondary" size="sm" onClick={() => enableAgent.mutate(agentId)}>
						<Power className="w-3 h-3" /> Enable
					</Button>
				)}
			</div>

			<div className="flex gap-1 border-b border-border mb-6">
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

export const Route = createFileRoute('/companies/$companyId/agents/$agentId')({
	component: AgentLayout,
});
