import { type AdminMentionItem, ApprovalStatus, ApprovalType } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Building2, Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { CreateProjectWithTeamDialog } from '../../components/create-project-with-team-dialog';
import { HqContainerNotice } from '../../components/hq-container-notice';
import { ProjectIntakeHomePanel } from '../../components/project-intake-home-panel';
import { Avatar, getInitials } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { RelativeTime } from '../../components/ui/relative-time';
import { useAllAdminMentions } from '../../hooks/use-admin-mentions';
import { type Approval, useAllApprovals } from '../../hooks/use-approvals';
import { useContainerHealth } from '../../hooks/use-container-health';
import { useProjectIntake } from '../../hooks/use-project-intake';
import {
	type ProjectWithTeam,
	useAllVisibleProjects,
	useHqProject,
} from '../../hooks/use-projects';
import { agentAvatarUrl } from '../../lib/agent-avatar';
import { inboxRowKind, inboxRowLead } from '../../lib/inbox-row-kind';

function formatMoney(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

/** A short, human phrase for an approval that needs the admin. */
function approvalText(a: Approval): string {
	const who = a.requested_by_name ?? 'An agent';
	switch (a.type) {
		case ApprovalType.DesignatedRepoRequest:
			return `${who} needs GitHub access to set up the repo`;
		case ApprovalType.PlanReview:
			return `${who} drafted a plan to review`;
		case ApprovalType.Hire:
			return `${who} wants to hire an agent`;
		case ApprovalType.DeployProduction:
			return `${who} wants to deploy to production`;
		case ApprovalType.SkillProposal:
			return `${who} proposed a reusable skill`;
		case ApprovalType.Strategy:
			return `${who} needs a strategy decision`;
		case ApprovalType.ProjectCreation:
			return `${who} proposed a new project`;
		default:
			return `${who} needs your approval`;
	}
}

function approvalActionLabel(type: string): string {
	if (type === ApprovalType.DesignatedRepoRequest) return 'Set up';
	if (type === ApprovalType.PlanReview) return 'Open plan';
	if (type === ApprovalType.SkillProposal) return 'Review';
	return 'Open';
}

type NeedsYouRow =
	| { kind: 'action'; id: string; createdAt: string; approval: Approval }
	| { kind: 'mention'; id: string; createdAt: string; mention: AdminMentionItem };

const NEEDS_YOU_PREVIEW = 5;

function NeedsYouSection({ projectSlugs }: { projectSlugs: string[] }) {
	const { data: approvals } = useAllApprovals(projectSlugs);
	const { data: mentions } = useAllAdminMentions(projectSlugs);

	const pending = (approvals ?? []).filter((a) => a.status === ApprovalStatus.Pending);
	const unread = (mentions ?? []).filter((m) => !m.read_at);

	const rows: NeedsYouRow[] = [
		...pending.map((a) => ({
			kind: 'action' as const,
			id: a.id,
			createdAt: a.created_at,
			approval: a,
		})),
		...unread.map((m) => ({
			kind: 'mention' as const,
			id: m.id,
			createdAt: m.created_at,
			mention: m,
		})),
	].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

	if (rows.length === 0) return null;
	const shown = rows.slice(0, NEEDS_YOU_PREVIEW);
	const more = rows.length - shown.length;

	return (
		<section className="mb-6" data-testid="home-needs-you">
			<h2 className="text-eyebrow mb-2">Needs you · {rows.length}</h2>
			<Card className="divide-y divide-border p-0">
				{shown.map((row) =>
					row.kind === 'action' ? (
						<NeedsYouAction key={`a-${row.id}`} approval={row.approval} />
					) : (
						<NeedsYouMention key={`m-${row.id}`} mention={row.mention} />
					),
				)}
			</Card>
			{more > 0 && (
				<div className="mt-2 text-center">
					<Link
						to="/home/inbox"
						className="text-[12px] text-info-soft-fg hover:underline"
						data-testid="home-needs-you-more"
					>
						Show {more} more
					</Link>
				</div>
			)}
		</section>
	);
}

const ACTION_LINK_CLASS =
	'shrink-0 rounded-md border border-border px-2 py-1 text-[12px] text-text-1 hover:bg-surface-2';

function NeedsYouRowShell({
	tag,
	tagColor,
	avatar,
	children,
	project,
	createdAt,
	actionLink,
}: {
	tag: string;
	tagColor: 'accent' | 'info' | 'warning';
	/**
	 * The actor behind the row, shown just before the text (which leads with their
	 * name). Rows with no identifiable actor pass nothing and get a same-width
	 * spacer instead, so the list stays aligned — synthesising initials from the
	 * "An agent" fallback label would show a misleading badge.
	 */
	avatar?: ReactNode;
	children: ReactNode;
	project: string | null;
	createdAt: string;
	actionLink: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2 px-3 py-2.5 sm:gap-3" data-testid="home-needs-you-row">
			<Badge color={tagColor} mono className="shrink-0">
				{tag}
			</Badge>
			{avatar ?? <span aria-hidden className="w-[26px] shrink-0" />}
			<span className="min-w-0 flex-1 truncate text-[13px] text-text-1">{children}</span>
			<span className="shrink-0 font-mono text-[11px] text-text-3">
				{project ? `${project} · ` : ''}
				<RelativeTime iso={createdAt} compact />
			</span>
			{actionLink}
		</div>
	);
}

function NeedsYouAction({ approval }: { approval: Approval }) {
	return (
		<NeedsYouRowShell
			tag="action"
			tagColor="accent"
			avatar={
				approval.requested_by_name ? (
					<Avatar
						size="sm"
						initials={getInitials(approval.requested_by_name)}
						imageUrl={
							approval.requested_by_icon_url ??
							agentAvatarUrl({
								slug: approval.requested_by_slug,
								avatar_spec: approval.requested_by_avatar_spec,
							})
						}
					/>
				) : undefined
			}
			project={approval.payload_project_slug}
			createdAt={approval.created_at}
			actionLink={
				<Link
					to="/projects/$projectId/inbox"
					params={{ projectId: approval.payload_project_slug ?? '' }}
					className={ACTION_LINK_CLASS}
				>
					{approvalActionLabel(approval.type)}
				</Link>
			}
		>
			{approvalText(approval)}
		</NeedsYouRowShell>
	);
}

function NeedsYouMention({ mention }: { mention: AdminMentionItem }) {
	const kind = inboxRowKind(mention.content_type);
	const lead = inboxRowLead(mention);
	return (
		<NeedsYouRowShell
			tag={kind.tag}
			tagColor={kind.tagColor}
			avatar={
				<Avatar
					size="sm"
					initials={getInitials(mention.author_display_name)}
					imageUrl={
						mention.author_icon_url ??
						agentAvatarUrl({ slug: mention.author_slug, avatar_spec: mention.author_avatar_spec })
					}
				/>
			}
			project={mention.project_slug}
			createdAt={mention.created_at}
			actionLink={
				<Link
					to="/projects/$projectId/tasks/$taskId"
					params={{
						projectId: mention.project_slug,
						taskId: mention.task_identifier.toLowerCase(),
					}}
					hash={`comment-${mention.comment_public_id}`}
					className={ACTION_LINK_CLASS}
				>
					{kind.actionLabel}
				</Link>
			}
		>
			{lead ? (
				<>
					<span className="font-medium">
						{mention.task_identifier}: {lead}
					</span>{' '}
					{mention.snippet}
				</>
			) : (
				<>
					<span className="font-medium">@{mention.author_slug ?? mention.author_display_name}</span>{' '}
					{mention.snippet}
				</>
			)}
		</NeedsYouRowShell>
	);
}

function WelcomeCard({ onCreate }: { onCreate: () => void }) {
	const hq = useHqProject();
	const hqHealth = useContainerHealth(hq);
	// Project scoping is CEO-driven, but a stopped (or never-provisioned) HQ
	// container is no blocker — the first use lazy-starts it. Only errors and
	// in-flight transitions surface a wait here.
	const blockedHealth =
		hqHealth && hqHealth.kind !== 'healthy' && hqHealth.kind !== 'stopped' ? hqHealth : null;

	return (
		<Card className="mb-6 p-0 overflow-hidden" data-testid="home-welcome-card">
			{hq && blockedHealth ? (
				<HqContainerNotice
					health={blockedHealth}
					description="Setting up Hezo. You can create your first project once the HQ container is running."
				/>
			) : (
				<div
					className="flex flex-col items-center gap-3 px-4 py-8 text-center"
					data-testid="home-welcome"
				>
					<Building2 className="w-8 h-8 text-text-2 shrink-0" />
					<div>
						<h1 className="text-base font-semibold text-text-1">Get started with Hezo</h1>
						<p className="text-[13px] text-text-2 mt-1 max-w-md">
							Create your first project. Each one gets its own team - spin it up from a template, or
							let the CEO scope it with you first.
						</p>
					</div>
					<Button onClick={onCreate} data-testid="home-welcome-create">
						<Plus className="w-4 h-4" />
						New project
					</Button>
				</div>
			)}
		</Card>
	);
}

function ActiveProjectCard({
	project,
	needsYou,
	showTeamName,
}: {
	project: ProjectWithTeam;
	needsYou: number;
	showTeamName: boolean;
}) {
	return (
		<Link to="/projects/$projectId" params={{ projectId: project.slug }}>
			<Card className="cursor-pointer h-full" data-testid="home-active-card">
				<div className="flex items-start gap-3">
					<Avatar initials={getInitials(project.name)} imageUrl={project.icon_url} />
					<div className="flex flex-col gap-1 min-w-0 flex-1">
						<div className="flex items-center justify-between gap-2">
							<h3 className="text-[15px] font-medium text-text-1 truncate">{project.name}</h3>
							{needsYou > 0 ? (
								<Badge color="accent" className="shrink-0">
									{needsYou} need you
								</Badge>
							) : project.running_agents_count > 0 ? (
								<Badge color="live" className="shrink-0">
									running
								</Badge>
							) : null}
						</div>
						{showTeamName && <p className="text-xs text-text-2 truncate">{project.teamName}</p>}
						{project.description && (
							<p className="text-xs text-text-2 line-clamp-2">{project.description}</p>
						)}
						<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-text-3">
							{project.running_agents_count > 0 && (
								<span className="text-live">{project.running_agents_count} running</span>
							)}
							<span>{project.open_task_count} tasks</span>
							<span>{formatMoney(project.today_spend_cents)} today</span>
						</div>
					</div>
				</div>
			</Card>
		</Link>
	);
}

// No container state on this row. Everything in "Other projects" is quiet by
// definition, and `container_status` no longer says whether a project is
// paused: containers are pooled per run, so `stopped` is what an idle project
// looks like and `error` latches on a column nothing reads. A real container
// failure is announced on the project's own page.
function OtherProjectRow({ project }: { project: ProjectWithTeam }) {
	return (
		<Link
			to="/projects/$projectId"
			params={{ projectId: project.slug }}
			data-testid="home-other-row"
		>
			<div className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2">
				<Avatar initials={getInitials(project.name)} imageUrl={project.icon_url} size="sm" />
				<span className="min-w-0 flex-1 truncate text-[13px] text-text-1">{project.name}</span>
				<span className="shrink-0 font-mono text-[11px] text-text-3">
					{project.open_task_count} tasks · <RelativeTime iso={project.last_activity_at} compact />
				</span>
			</div>
		</Link>
	);
}

function ProjectsDashboard({
	projects,
	needsYouBySlug,
	onCreate,
}: {
	projects: ProjectWithTeam[];
	needsYouBySlug: Map<string, number>;
	onCreate: () => void;
}) {
	const showTeamName = projects.length > 1;
	const isActive = (p: ProjectWithTeam) =>
		p.running_agents_count > 0 || (needsYouBySlug.get(p.slug) ?? 0) > 0;
	const active = projects.filter(isActive);
	const other = projects.filter((p) => !isActive(p));

	return (
		<div data-testid="home-projects">
			<div className="mb-4 flex items-center justify-between">
				<h2 className="text-eyebrow">Active projects · {active.length}</h2>
				<Button variant="secondary" size="sm" onClick={onCreate} data-testid="home-new-project">
					<Plus className="w-4 h-4" />
					New project
				</Button>
			</div>
			{active.length > 0 ? (
				<div
					className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
					data-testid="home-active"
				>
					{active.map((p) => (
						<ActiveProjectCard
							key={p.id}
							project={p}
							needsYou={needsYouBySlug.get(p.slug) ?? 0}
							showTeamName={showTeamName}
						/>
					))}
				</div>
			) : (
				<p className="text-[13px] text-text-3">No active projects right now.</p>
			)}

			{other.length > 0 && (
				<section className="mt-6" data-testid="home-other">
					<h2 className="text-eyebrow mb-2">Other projects · {other.length}</h2>
					<Card className="divide-y divide-border p-0">
						{other.map((p) => (
							<OtherProjectRow key={p.id} project={p} />
						))}
					</Card>
				</section>
			)}
		</div>
	);
}

function HomePage() {
	const { projects, isLoading: projectsLoading } = useAllVisibleProjects();
	const [createOpen, setCreateOpen] = useState(false);

	const projectSlugs = projects.map((p) => p.slug);
	const { data: approvals } = useAllApprovals(projectSlugs);
	const { data: mentions } = useAllAdminMentions(projectSlugs);

	// Per-project "needs you" tally (pending approvals + unread mentions), used to
	// rank projects into Active vs Other and to badge the cards.
	const needsYouBySlug = new Map<string, number>();
	for (const a of approvals ?? []) {
		if (a.status === ApprovalStatus.Pending && a.payload_project_slug) {
			needsYouBySlug.set(
				a.payload_project_slug,
				(needsYouBySlug.get(a.payload_project_slug) ?? 0) + 1,
			);
		}
	}
	for (const m of mentions ?? []) {
		if (!m.read_at)
			needsYouBySlug.set(m.project_slug, (needsYouBySlug.get(m.project_slug) ?? 0) + 1);
	}

	// The CEO-assisted intake lives in HQ and is instance-wide; only surface it
	// while the welcome view is showing (no user-facing projects yet).
	const noProjectsYet = !projectsLoading && projects.length === 0;
	const { data: intake } = useProjectIntake(noProjectsYet);

	if (projectsLoading) {
		return <div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6 text-text-2">Loading...</div>;
	}

	const hasProject = projects.length > 0;
	const hasIntake = !!intake;
	const showWelcome = !hasProject && !hasIntake;

	return (
		<div className="max-w-7xl mx-auto w-full px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
			<div className="mb-5 flex items-baseline justify-between gap-3">
				<h1 className="text-[22px] md:text-[28px] font-semibold tracking-[-0.02em]">Home</h1>
			</div>

			{showWelcome && <WelcomeCard onCreate={() => setCreateOpen(true)} />}

			{hasIntake && intake && (
				<div className="mb-6" data-testid="home-project-intake-section">
					<ProjectIntakeHomePanel intake={intake} />
				</div>
			)}

			{hasProject && (
				<>
					<NeedsYouSection projectSlugs={projectSlugs} />
					{projectsLoading ? (
						<div
							className="text-text-2 text-[13px] py-8 text-center"
							data-testid="home-projects-loading"
						>
							Loading projects...
						</div>
					) : (
						<ProjectsDashboard
							projects={projects}
							needsYouBySlug={needsYouBySlug}
							onCreate={() => setCreateOpen(true)}
						/>
					)}
				</>
			)}

			<CreateProjectWithTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}

export const Route = createFileRoute('/home/')({
	component: HomePage,
});
