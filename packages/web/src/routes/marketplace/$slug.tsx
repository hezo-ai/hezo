import type { MarketplaceRosterAgent } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Check, ChevronRight, Loader2, Store } from 'lucide-react';
import { useState } from 'react';
import { CreateProjectWithTeamDialog } from '../../components/create-project-with-team-dialog';
import { HiringForBanner } from '../../components/hiring-for-banner';
import { marketplaceRosterRows, TeamRosterTable } from '../../components/team-roster-table';
import { Avatar, getInitials } from '../../components/ui/avatar';
import { Badge } from '../../components/ui/badge';
import { BreadcrumbRow } from '../../components/ui/breadcrumb';
import { Button } from '../../components/ui/button';
import { DialogContent } from '../../components/ui/dialog';
import { useAddMarketplaceTeam, useMarketplaceTeam } from '../../hooks/use-marketplace';
import { useAllVisibleProjects, useProjectMeta } from '../../hooks/use-projects';
import { toast } from '../../hooks/use-toast';
import { agentAvatarUrl } from '../../lib/agent-avatar';
import { useI18n } from '../../lib/i18n';

interface MarketplaceTeamSearch {
	/** The project a hire was started from; see `routes/marketplace/index.tsx`. */
	forProject?: string;
}

function MarketplaceTeamDetail() {
	const { t } = useI18n();
	const { slug } = Route.useParams();
	const { forProject } = Route.useSearch();
	const { data: team, isLoading } = useMarketplaceTeam(slug);
	const [launchOpen, setLaunchOpen] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const hiringFor = useProjectMeta(forProject);

	return (
		<div className="max-w-[900px] mx-auto p-4 sm:p-6 lg:p-8" data-testid="marketplace-detail">
			{forProject && (
				<HiringForBanner projectId={forProject} messageKey="agents.hire.hiringForTeam" />
			)}

			{/* Keeps its own `<Link>` rather than taking the `Breadcrumb` component,
			    whose segments are buttons: this one is a real link, and middle-click and
			    open-in-new-tab are worth more here than the shared markup. It still takes
			    the shared row, so it scrolls the way every other crumb does. */}
			<BreadcrumbRow className="mb-4 text-[13px] text-text-2">
				<Link
					to="/marketplace"
					search={forProject ? { forProject } : {}}
					className="hover:text-text-1 flex shrink-0 items-center gap-1 whitespace-nowrap"
				>
					<Store className="w-3.5 h-3.5 shrink-0" /> {t('marketplace.title')}
				</Link>
				<ChevronRight className="w-3.5 h-3.5 shrink-0" />
				<span className="shrink-0 whitespace-nowrap text-text-1">{team?.name ?? slug}</span>
			</BreadcrumbRow>

			{isLoading ? (
				<div className="flex items-center gap-2 text-text-2 text-[13px] py-8">
					<Loader2 className="w-4 h-4 animate-spin" /> {t('common.loading')}
				</div>
			) : !team ? (
				<p className="text-text-2 text-[13px]">{t('marketplace.notFound')}</p>
			) : (
				<>
					<div className="flex items-start justify-between gap-3 flex-wrap mb-2">
						<div>
							<div className="flex items-center gap-2">
								<h1 className="text-xl font-semibold">{team.name}</h1>
								<Badge color="neutral">v{team.version}</Badge>
							</div>
							<p className="text-[13px] text-text-2 mt-1 max-w-[600px]">{team.description}</p>
						</div>
						{/* Arriving mid-hire makes adding to that project the task at hand, so it
						    leads. Launching a whole new project stays reachable rather than
						    dead-ending someone who changes their mind. */}
						<div className="flex gap-2">
							{forProject ? (
								<>
									<Button onClick={() => setAddOpen(true)} data-testid="marketplace-add-existing">
										{t('agents.hire.addToProject', {
											project: hiringFor?.name ?? forProject,
										})}
									</Button>
									<Button
										variant="secondary"
										onClick={() => setLaunchOpen(true)}
										data-testid="marketplace-launch"
									>
										{t('marketplace.launchProject')}
									</Button>
								</>
							) : (
								<>
									<Button onClick={() => setLaunchOpen(true)} data-testid="marketplace-launch">
										{t('marketplace.launchProject')}
									</Button>
									<Button
										variant="secondary"
										onClick={() => setAddOpen(true)}
										data-testid="marketplace-add-existing"
									>
										{t('marketplace.addToProject')}
									</Button>
								</>
							)}
						</div>
					</div>

					<section className="mt-6">
						<h2 className="text-[15px] font-medium mb-2">
							{t('marketplace.rosterHeading', { count: team.roster.length + 1 })}
						</h2>
						<TeamRosterTable rows={marketplaceRosterRows(team)} testId="marketplace-roster" />
					</section>

					{team.changelog.length > 0 && (
						<section className="mt-8">
							<h2 className="text-[15px] font-medium mb-2">{t('marketplace.changelog')}</h2>
							<ul className="space-y-1.5">
								{team.changelog.map((c) => (
									<li key={c.version} className="text-[13px] text-text-2">
										<span className="font-medium text-text-1">v{c.version}</span>
										{c.notes ? ` - ${c.notes}` : ''}
									</li>
								))}
							</ul>
						</section>
					)}

					<CreateProjectWithTeamDialog
						open={launchOpen}
						onOpenChange={setLaunchOpen}
						initialMarketplaceSlug={slug}
					/>
					<AddToProjectDialog
						open={addOpen}
						onOpenChange={setAddOpen}
						slug={slug}
						teamName={team.name}
						roster={team.roster}
						initialProjectId={forProject}
					/>
				</>
			)}
		</div>
	);
}

/**
 * Pick a project to add this marketplace team to, either whole or as a subset of its
 * roles. The roster checkboxes are driven by the def's `roster`, which never contains
 * the Captain (`RESERVED_ROSTER_SLUGS` forbids it) — that is also the product rule:
 * every project already has a Captain, so it is not selectable.
 *
 * `initialProjectId` is set when the operator got here from a project's hire flow.
 * That also flips the default scope to "choose roles": they pressed **Hire agent**,
 * which is a request for a teammate, not for a second roster.
 */
function AddToProjectDialog({
	open,
	onOpenChange,
	slug,
	teamName,
	roster,
	initialProjectId,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	slug: string;
	teamName: string;
	roster: MarketplaceRosterAgent[];
	initialProjectId?: string;
}) {
	const { t } = useI18n();
	const { projects } = useAllVisibleProjects();
	const [projectId, setProjectId] = useState(initialProjectId ?? '');
	const [wholeTeam, setWholeTeam] = useState(!initialProjectId);
	const [picked, setPicked] = useState<string[]>([]);
	const selected = projects.find((p) => p.slug === projectId);
	const add = useAddMarketplaceTeam(selected?.slug ?? '');
	const navigate = useNavigate();
	const roles = [...roster].sort((a, b) => a.sort_order - b.sort_order);
	const canSubmit = projectId.length > 0 && (wholeTeam || picked.length > 0) && !add.isPending;

	function reset() {
		setProjectId(initialProjectId ?? '');
		setWholeTeam(!initialProjectId);
		setPicked([]);
	}

	function togglePicked(roleSlug: string) {
		setPicked((prev) =>
			prev.includes(roleSlug) ? prev.filter((s) => s !== roleSlug) : [...prev, roleSlug],
		);
	}

	async function submit() {
		if (!selected) return;
		// Send the roles in roster order rather than click order, so the CEO reads
		// them in the same order the team page lists them.
		const chosen = roles.filter((r) => picked.includes(r.slug));
		const res = await add.mutateAsync({
			slug,
			roles: wholeTeam ? undefined : chosen.map((r) => r.slug),
		});
		onOpenChange(false);
		reset();
		const href = `/projects/${selected.slug}/tasks/${res.task_identifier.toLowerCase()}`;
		const what = wholeTeam
			? t('marketplace.addingTeam', { team: teamName })
			: chosen.length === 1
				? t('marketplace.addingRole', { role: chosen[0].title })
				: t('marketplace.addingRoles', { count: chosen.length, team: teamName });
		toast.success(t('marketplace.addStarted', { what, project: selected.name }), {
			link: {
				label: t('marketplace.viewTask'),
				href,
				onNavigate: () =>
					navigate({
						to: '/projects/$projectId/tasks/$taskId',
						params: { projectId: selected.slug, taskId: res.task_identifier.toLowerCase() },
					}),
			},
		});
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="md">
				<Dialog.Title className="text-base font-medium mb-1 pr-8">
					{selected
						? t('marketplace.addTitleForProject', { team: teamName, project: selected.name })
						: t('marketplace.addTitle', { team: teamName })}
				</Dialog.Title>
				<Dialog.Description className="text-[13px] text-text-2 mb-4">
					{t('marketplace.addDescription')}
				</Dialog.Description>
				<label className="flex flex-col gap-1 text-[13px] font-medium text-text-1">
					{t('marketplace.projectLabel')}
					<select
						value={projectId}
						onChange={(e) => setProjectId(e.target.value)}
						data-testid="add-to-project-select"
						className="border border-border rounded-md px-3 py-2 text-[13px] bg-surface text-text-1"
					>
						<option value="">{t('marketplace.chooseProject')}</option>
						{projects.map((p) => (
							<option key={p.slug} value={p.slug}>
								{p.name}
							</option>
						))}
					</select>
				</label>

				<fieldset className="mt-4">
					<legend className="text-[13px] font-medium text-text-1 mb-1.5">
						{t('marketplace.whatToAdd')}
					</legend>
					<label className="flex items-start gap-2 text-[13px] py-1 cursor-pointer">
						<input
							type="radio"
							name="add-scope"
							className="mt-0.5"
							checked={wholeTeam}
							onChange={() => setWholeTeam(true)}
							data-testid="add-scope-whole-team"
						/>
						<span>
							{t('marketplace.wholeTeam')}
							<span className="text-text-2"> ({roles.length})</span>
						</span>
					</label>
					<label className="flex items-start gap-2 text-[13px] py-1 cursor-pointer">
						<input
							type="radio"
							name="add-scope"
							className="mt-0.5"
							checked={!wholeTeam}
							onChange={() => setWholeTeam(false)}
							data-testid="add-scope-pick-roles"
						/>
						<span>{t('marketplace.chooseRoles')}</span>
					</label>

					{!wholeTeam && (
						<div className="mt-2 pl-6" data-testid="add-role-picker">
							{/* Named and faced rather than a plain checklist: a marketplace roster
							    ships a fixed person per role, and this is the moment the operator
							    decides to bring *them* in. The same identity shows on the roster
							    table above and everywhere the agent appears once hired. */}
							<ul className="max-h-[220px] overflow-y-auto rounded-md border border-border divide-y divide-border/60">
								{roles.map((r) => {
									const name = r.human_name ?? r.title;
									return (
										<li key={r.slug}>
											<label className="flex items-center gap-2.5 px-3 py-2 text-[13px] cursor-pointer">
												<input
													type="checkbox"
													checked={picked.includes(r.slug)}
													onChange={() => togglePicked(r.slug)}
													data-testid={`add-role-${r.slug}`}
												/>
												<Avatar
													initials={getInitials(name)}
													size="sm"
													imageUrl={agentAvatarUrl({ slug: r.slug, avatar_spec: r.avatar_spec })}
												/>
												<span className="min-w-0">
													<span className="font-medium">{name}</span>
													{r.human_name && (
														<span className="text-[12px] text-text-2"> {r.title}</span>
													)}
													<span className="block text-[12px] text-text-2">
														{r.role_description}
													</span>
												</span>
											</label>
										</li>
									);
								})}
							</ul>
						</div>
					)}
				</fieldset>

				{add.error && (
					<p className="text-[13px] text-danger mt-2">
						{(add.error as { message?: string }).message || t('marketplace.addFailed')}
					</p>
				)}
				<div className="flex justify-end gap-2 mt-4">
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						{t('common.cancel')}
					</Button>
					<Button onClick={submit} disabled={!canSubmit} data-testid="add-to-project-submit">
						{add.isPending ? (
							<Loader2 className="w-4 h-4 animate-spin" />
						) : (
							<Check className="w-4 h-4" />
						)}
						{add.isPending
							? t('marketplace.starting')
							: wholeTeam
								? t('marketplace.addTeamAction')
								: picked.length === 1
									? t('marketplace.addRoleAction')
									: t('marketplace.addRolesAction', { count: picked.length })}
					</Button>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}

export const Route = createFileRoute('/marketplace/$slug')({
	validateSearch: (search: Record<string, unknown>): MarketplaceTeamSearch => ({
		forProject: typeof search.forProject === 'string' ? search.forProject : undefined,
	}),
	component: MarketplaceTeamDetail,
});
