import { createFileRoute, Link } from '@tanstack/react-router';
import { Globe, Plus, UserPlus } from 'lucide-react';
import { agentPageParams } from '../../../../components/agent-link';
import { AgentStatusLabel } from '../../../../components/agent-status-label';
import { OrgChartTree } from '../../../../components/org-chart-tree';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { ExpandableText } from '../../../../components/ui/expandable-text';
import { StatusDot } from '../../../../components/ui/status-dot';
import { useAgents } from '../../../../hooks/use-agents';
import { useOrgChart } from '../../../../hooks/use-org-chart';
import { useTeam } from '../../../../hooks/use-teams';

/** HQ agents (CEO/Coach) shown as virtual members, linking to their HQ pages. */
function GlobalAgentsBox({ projectId }: { projectId: string }) {
	const { data: agents } = useAgents(projectId);
	const instanceAgents = (agents ?? []).filter((a) => a.is_instance);
	if (instanceAgents.length === 0) return null;

	return (
		<aside
			data-testid="global-agents-box"
			className="rounded-lg border border-border-subtle bg-bg-subtle p-3"
		>
			<div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-text-subtle font-medium mb-2">
				<Globe className="w-3 h-3" /> Global agents
			</div>
			<p className="text-xs text-text-muted mb-3">Work across every project.</p>
			<div className="flex flex-col gap-1">
				{instanceAgents.map((agent) => (
					<Link
						key={agent.id}
						to="/projects/$projectId/agents/$agentId"
						params={agentPageParams(projectId, agent.slug, agent.is_instance)}
						className="text-[13px] text-text-muted hover:text-text hover:bg-bg-subtle rounded-radius-md px-2 py-1 transition-colors"
					>
						<AgentStatusLabel name={agent.title} runtimeStatus={agent.runtime_status} />
					</Link>
				))}
			</div>
		</aside>
	);
}

function TeamPage() {
	const { projectId } = Route.useParams();
	const { data: orgChart, isLoading } = useOrgChart(projectId);
	const { data: team } = useTeam(projectId);

	if (isLoading)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	const roots = orgChart?.admin.children ?? [];
	const hasMembers = roots.length > 0;

	return (
		<div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] lg:gap-6">
			<div className="min-w-0">
				<div className="flex items-center justify-end mb-4">
					<Link to="/projects/$projectId/agents/hire" params={{ projectId }}>
						<Button>
							<UserPlus className="w-4 h-4" /> Hire agent
						</Button>
					</Link>
				</div>

				<div
					data-testid="team-summary"
					className="rounded-lg border border-border-subtle bg-bg-subtle p-4 text-sm leading-relaxed text-text mb-1"
				>
					<ExpandableText
						text={team?.summary ?? ''}
						placeholder={
							<span className="italic text-text-muted">Team description being generated…</span>
						}
					/>
				</div>
				<p data-testid="team-summary-attribution" className="text-xs text-text-muted italic mb-6">
					Auto-generated from the agents' system prompts.
				</p>

				{!hasMembers ? (
					<EmptyState icon={<Plus className="w-10 h-10" />} title="No team members yet" />
				) : (
					<>
						<div className="pt-4">
							<OrgChartTree
								roots={roots}
								projectId={projectId}
								mode="interactive"
								testId="team-org-chart"
							/>
						</div>

						<div className="flex items-center gap-4 mt-8 pt-4 border-t border-border text-xs text-text-muted">
							<div className="flex items-center gap-1.5">
								<StatusDot status="active" /> Active
							</div>
							<div className="flex items-center gap-1.5">
								<StatusDot status="paused" /> Paused
							</div>
							<div className="flex items-center gap-1.5">
								<StatusDot status="disabled" /> Disabled
							</div>
						</div>
					</>
				)}
			</div>

			<div className="mt-4 lg:mt-0">
				<GlobalAgentsBox projectId={projectId} />
			</div>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/agents/')({
	component: TeamPage,
});
