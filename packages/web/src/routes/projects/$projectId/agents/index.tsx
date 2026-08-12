import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Globe, Plus, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { agentDisplayName } from '../../../../components/agent-identity-tooltip';
import { agentPageParams } from '../../../../components/agent-link';
import { AgentStatusLabel } from '../../../../components/agent-status-label';
import { ExportTeamButton } from '../../../../components/export-team-dialog';
import { HireAgentChooserDialog } from '../../../../components/hire-agent-chooser-dialog';
import { OrgChartTree } from '../../../../components/org-chart-tree';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import { ExpandableText } from '../../../../components/ui/expandable-text';
import { StatusDot } from '../../../../components/ui/status-dot';
import { useAgents } from '../../../../hooks/use-agents';
import { useOrgChart } from '../../../../hooks/use-org-chart';
import { useProjectMeta } from '../../../../hooks/use-projects';
import { useTeam } from '../../../../hooks/use-teams';
import { useI18n } from '../../../../lib/i18n';

/** HQ agents (CEO/Coach) shown as virtual members, linking to their HQ pages. */
function GlobalAgentsBox({ projectId }: { projectId: string }) {
	const { data: agents } = useAgents(projectId);
	const instanceAgents = (agents ?? []).filter((a) => a.is_instance);
	if (instanceAgents.length === 0) return null;

	return (
		<aside
			data-testid="global-agents-box"
			className="rounded-lg border border-border-subtle bg-surface-2 p-3"
		>
			<div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-text-3 font-medium mb-2">
				<Globe className="w-3 h-3" /> Global agents
			</div>
			<p className="text-xs text-text-2 mb-3">Work across every project.</p>
			<div className="flex flex-col gap-1">
				{instanceAgents.map((agent) => (
					<Link
						key={agent.id}
						to="/projects/$projectId/agents/$agentId"
						params={agentPageParams(projectId, agent.slug, agent.is_instance)}
						className="text-[13px] text-text-2 hover:text-text-1 hover:bg-surface-2 rounded-md px-2 py-1 transition-colors"
					>
						<AgentStatusLabel name={agentDisplayName(agent)} runtimeStatus={agent.runtime_status} />
					</Link>
				))}
			</div>
		</aside>
	);
}

function TeamPage() {
	const { t } = useI18n();
	const { projectId } = Route.useParams();
	const { hire } = Route.useSearch();
	const navigate = useNavigate();
	const { data: orgChart, isLoading } = useOrgChart(projectId);
	const { data: team } = useTeam(projectId);
	const project = useProjectMeta(projectId);
	const [chooserOpen, setChooserOpen] = useState(false);

	// `?hire` opens the chooser on arrival, which is how the hire form's back link
	// returns to the fork. Dismissing clears the param so the next visit to this
	// page (or a browser back into it) is not met by the dialog again.
	const chooserVisible = chooserOpen || hire === true;
	function setChooserVisible(next: boolean) {
		setChooserOpen(next);
		if (!next && hire) {
			navigate({ to: '/projects/$projectId/agents', params: { projectId }, replace: true });
		}
	}

	if (isLoading)
		return <div className="text-text-2 text-[13px] py-8 text-center">{t('common.loading')}</div>;

	const roots = orgChart?.admin.children ?? [];
	const hasMembers = roots.length > 0;
	// HQ hosts the two instance singletons (CEO, Coach) and nothing else - it is
	// not a team you staff, and marketplace roles are written for project teams.
	const canHire = !(project?.is_internal ?? false);

	return (
		<div className="grid grid-cols-1 lg:grid-cols-[1fr_240px] lg:gap-6">
			<div className="min-w-0">
				<div className="flex items-center justify-end gap-2 mb-4">
					{canHire && (
						<Button onClick={() => setChooserOpen(true)} data-testid="hire-agent">
							<UserPlus className="w-4 h-4" /> {t('agents.hire.action')}
						</Button>
					)}
					<ExportTeamButton projectId={projectId} />
				</div>

				{canHire && (
					<HireAgentChooserDialog
						projectId={projectId}
						open={chooserVisible}
						onOpenChange={setChooserVisible}
					/>
				)}

				<div
					data-testid="team-summary"
					className="rounded-lg border border-border-subtle bg-surface-2 p-4 text-sm leading-relaxed text-text-1 mb-1"
				>
					<ExpandableText
						text={team?.summary ?? ''}
						projectId={projectId}
						placeholder={
							<span className="italic text-text-2">Team description being generated…</span>
						}
					/>
				</div>
				<p data-testid="team-summary-attribution" className="text-xs text-text-2 italic mb-6">
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

						<div className="flex items-center gap-4 mt-8 pt-4 border-t border-border text-xs text-text-2">
							<div className="flex items-center gap-1.5">
								<StatusDot status="active" /> Active
							</div>
							<div className="flex items-center gap-1.5">
								<StatusDot status="paused" /> Over budget
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

interface TeamPageSearch {
	/** Open the hire chooser on arrival (the hire form's back link). */
	hire?: boolean;
}

export const Route = createFileRoute('/projects/$projectId/agents/')({
	validateSearch: (search: Record<string, unknown>): TeamPageSearch => ({
		hire: search.hire === true || search.hire === 'true' ? true : undefined,
	}),
	component: TeamPage,
});
