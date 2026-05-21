import { createFileRoute, Link } from '@tanstack/react-router';
import { Plus, UserPlus } from 'lucide-react';
import { OrgChartTree } from '../../../../components/org-chart-tree';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { ExpandableText } from '../../../../components/ui/expandable-text';
import { StatusDot } from '../../../../components/ui/status-dot';
import { useOrgChart } from '../../../../hooks/use-org-chart';
import { useTeam } from '../../../../hooks/use-teams';

function TeamPage() {
	const { teamId } = Route.useParams();
	const { data: orgChart, isLoading } = useOrgChart(teamId);
	const { data: team } = useTeam(teamId);

	if (isLoading)
		return <div className="text-text-muted text-[13px] py-8 text-center">Loading...</div>;

	const roots = orgChart?.board.children ?? [];
	const hasMembers = roots.length > 0;

	return (
		<div>
			<div className="flex items-center justify-end mb-4">
				<Link to="/teams/$teamId/agents/hire" params={{ teamId }}>
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
							teamId={teamId}
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
	);
}

export const Route = createFileRoute('/teams/$teamId/agents/')({
	component: TeamPage,
});
