import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus, UserPlus } from 'lucide-react';
import { Avatar, avatarColorFromString } from '../../../../components/ui/avatar';
import { Badge } from '../../../../components/ui/badge';
import { BudgetBar } from '../../../../components/ui/budget-bar';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { StatusDot } from '../../../../components/ui/status-dot';
import { useAgents } from '../../../../hooks/use-agents';

function runtimeDot(status: string): 'active' | 'idle' | 'paused' {
	if (status === 'active') return 'active';
	if (status === 'paused') return 'paused';
	return 'idle';
}

function adminBadge(status: string): { color: string; label: string } {
	if (status === 'disabled') return { color: 'warning', label: 'Disabled' };
	if (status === 'terminated') return { color: 'neutral', label: 'Terminated' };
	return { color: 'success', label: 'Enabled' };
}

function getInitials(title: string): string {
	const words = title.split(/\s+/);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return title.slice(0, 2).toUpperCase();
}

function AgentListPage() {
	const { companyId } = Route.useParams();
	const { data: agents, isLoading } = useAgents(companyId);

	if (isLoading)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	return (
		<div>
			<div className="flex items-center justify-end mb-4">
				<Link to="/companies/$companyId/agents/hire" params={{ companyId }}>
					<Button>
						<UserPlus className="w-4 h-4" /> Hire agent
					</Button>
				</Link>
			</div>

			{agents?.length === 0 ? (
				<EmptyState icon={<Plus className="w-10 h-10" />} title="No agents yet" />
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
					{agents?.map((agent) => {
						const admin = adminBadge(agent.admin_status);
						const budgetUsed = agent.budget_used_cents / 100;
						const budgetTotal = agent.monthly_budget_cents / 100;
						return (
							<Link
								key={agent.id}
								to="/companies/$companyId/agents/$agentId"
								params={{ companyId, agentId: agent.id }}
							>
								<div className="border border-border rounded-radius-lg p-4 bg-bg transition-[border-color] duration-150 hover:border-border-hover cursor-pointer">
									<div className="flex items-center gap-2.5 mb-3">
										<Avatar
											initials={getInitials(agent.title)}
											size="md"
											color={avatarColorFromString(agent.title)}
										/>
										<div className="min-w-0">
											<div className="text-sm font-medium truncate">{agent.title}</div>
											{agent.role_description && (
												<div className="text-xs text-text-muted truncate">
													{agent.role_description}
												</div>
											)}
										</div>
									</div>

									<div className="text-xs text-text-muted leading-relaxed space-y-0.5">
										<div className="flex items-center gap-1.5">
											<StatusDot status={runtimeDot(agent.runtime_status)} />
											<Badge color={admin.color as 'neutral'}>{admin.label}</Badge>
											{agent.runtime_status === 'active' && <Badge color="success">Active</Badge>}
										</div>
										<div>Runtime: {agent.runtime_type}</div>
										<div>Heartbeat: {agent.heartbeat_interval_min}m</div>
										{budgetTotal > 0 && (
											<div>
												Budget: ${budgetUsed.toFixed(0)} / ${budgetTotal.toFixed(0)}
											</div>
										)}
									</div>

									{budgetTotal > 0 && (
										<BudgetBar used={budgetUsed} total={budgetTotal} className="mt-2" />
									)}
								</div>
							</Link>
						);
					})}
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/agents/')({
	component: AgentListPage,
});
