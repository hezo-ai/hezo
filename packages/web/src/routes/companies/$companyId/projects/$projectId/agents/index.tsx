import { AgentAdminStatus, AgentRuntimeStatus } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus, UserPlus } from 'lucide-react';
import { Avatar, avatarColorFromString } from '../../../../../../components/ui/avatar';
import { Badge } from '../../../../../../components/ui/badge';
import { BudgetBar } from '../../../../../../components/ui/budget-bar';
import { Button } from '../../../../../../components/ui/button';
import { EmptyState } from '../../../../../../components/ui/empty-state';
import { StatusDot } from '../../../../../../components/ui/status-dot';
import { useAgents } from '../../../../../../hooks/use-agents';

function runtimeDot(status: string): 'active' | 'idle' | 'paused' {
	if (status === AgentRuntimeStatus.Active) return 'active';
	if (status === AgentRuntimeStatus.Paused) return 'paused';
	return 'idle';
}

function runtimeBadge(status: string): { color: string; label: string } {
	if (status === AgentRuntimeStatus.Active) return { color: 'success', label: 'Running' };
	if (status === AgentRuntimeStatus.Paused) return { color: 'warning', label: 'Paused' };
	return { color: 'neutral', label: 'Idle' };
}

function getInitials(title: string): string {
	const words = title.split(/\s+/);
	if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
	return title.slice(0, 2).toUpperCase();
}

function ProjectAgentListPage() {
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
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
					{agents?.map((agent) => {
						const isDisabled = agent.admin_status === AgentAdminStatus.Disabled;
						const isTerminated = agent.admin_status === AgentAdminStatus.Terminated;
						const runtime = runtimeBadge(agent.runtime_status);
						const budgetUsed = agent.budget_used_cents / 100;
						const budgetTotal = agent.monthly_budget_cents / 100;
						return (
							<Link
								key={agent.id}
								to="/companies/$companyId/agents/$agentId"
								params={{ companyId, agentId: agent.id }}
							>
								<div
									className={`border border-border rounded-radius-lg p-4 bg-bg transition-[border-color] duration-150 hover:border-border-hover cursor-pointer${isDisabled ? ' opacity-50' : ''}`}
								>
									<div className="flex items-center gap-2.5 mb-3">
										<Avatar
											initials={getInitials(agent.title)}
											size="md"
											color={avatarColorFromString(agent.title)}
										/>
										<div className="min-w-0">
											<div className="text-sm font-medium truncate">
												{agent.title}
												{isDisabled ? ' (disabled)' : ''}
											</div>
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
											{isTerminated ? (
												<Badge color="neutral">Terminated</Badge>
											) : (
												<Badge color={runtime.color as 'neutral'}>{runtime.label}</Badge>
											)}
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

export const Route = createFileRoute('/companies/$companyId/projects/$projectId/agents/')({
	component: ProjectAgentListPage,
});
