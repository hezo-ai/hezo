import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus, UserPlus } from 'lucide-react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Card } from '../../../../components/ui/card';
import { EmptyState } from '../../../../components/ui/empty-state';
import { useAgents } from '../../../../hooks/use-agents';

const statusColors: Record<string, string> = {
	active: 'green',
	idle: 'blue',
	paused: 'yellow',
	terminated: 'gray',
};

const statusDot: Record<string, string> = {
	active: 'bg-success',
	idle: 'bg-info',
	paused: 'bg-warning',
	terminated: 'bg-bg-elevated',
};

function AgentListPage() {
	const { companyId } = Route.useParams();
	const { data: agents, isLoading } = useAgents(companyId);

	if (isLoading) return <div className="p-6 text-text-muted">Loading...</div>;

	return (
		<div className="p-6">
			<div className="flex items-center justify-between mb-4">
				<h1 className="text-lg font-semibold">Agents</h1>
				<Link to="/companies/$companyId/agents/hire" params={{ companyId }}>
					<Button size="sm">
						<UserPlus className="w-4 h-4" /> Hire Agent
					</Button>
				</Link>
			</div>

			{agents?.length === 0 ? (
				<EmptyState icon={<Plus className="w-10 h-10" />} title="No agents yet" />
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
					{agents?.map((agent) => {
						const budgetPct =
							agent.monthly_budget_cents > 0
								? Math.round((agent.budget_used_cents / agent.monthly_budget_cents) * 100)
								: 0;
						return (
							<Link
								key={agent.id}
								to="/companies/$companyId/agents/$agentId"
								params={{ companyId, agentId: agent.id }}
							>
								<Card className="hover:border-primary/50 transition-colors cursor-pointer">
									<div className="flex items-start justify-between mb-2">
										<div className="flex items-center gap-2">
											<span
												className={`w-2 h-2 rounded-full ${statusDot[agent.status] || 'bg-bg-elevated'} ${agent.status === 'active' ? 'animate-pulse' : ''}`}
											/>
											<h3 className="font-medium text-sm">{agent.title}</h3>
										</div>
										<Badge color={statusColors[agent.status] as 'gray'}>{agent.status}</Badge>
									</div>
									{agent.role_description && (
										<p className="text-xs text-text-muted line-clamp-2 mb-3">
											{agent.role_description}
										</p>
									)}
									<div className="flex items-center justify-between text-xs text-text-subtle">
										<span>{agent.runtime_type}</span>
										<span>{agent.assigned_issue_count} issues</span>
									</div>
									{agent.last_heartbeat_at && (
										<div className="text-[10px] text-text-subtle mt-1">
											Last heartbeat: {new Date(agent.last_heartbeat_at).toLocaleTimeString()}
										</div>
									)}
									{agent.monthly_budget_cents > 0 && (
										<div className="mt-2">
											<div className="h-1.5 rounded-full bg-bg-muted overflow-hidden">
												<div
													className={`h-full rounded-full transition-all ${budgetPct > 80 ? 'bg-danger' : budgetPct > 60 ? 'bg-warning' : 'bg-primary'}`}
													style={{ width: `${Math.min(budgetPct, 100)}%` }}
												/>
											</div>
											<span className="text-[10px] text-text-subtle">
												${(agent.budget_used_cents / 100).toFixed(2)} / $
												{(agent.monthly_budget_cents / 100).toFixed(2)}
											</span>
										</div>
									)}
								</Card>
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
