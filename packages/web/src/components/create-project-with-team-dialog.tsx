import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import {
	ArrowLeft,
	ArrowRight,
	Check,
	ChevronRight,
	Loader2,
	MessagesSquare,
	Search,
	Sparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { setActiveTeamSlug } from '../hooks/use-active-team-slug';
import { useAgents } from '../hooks/use-agents';
import { useCloseOnRouteChange } from '../hooks/use-close-on-route-change';
import { useContainerHealth } from '../hooks/use-container-health';
import { useMarketplaceTeam, useMarketplaceTeams } from '../hooks/use-marketplace';
import { useStartProjectIntake } from '../hooks/use-project-intake';
import {
	useAllVisibleProjects,
	useCreateProjectWithTeam,
	useHqProject,
} from '../hooks/use-projects';
import { useTeamTemplates } from '../hooks/use-team-templates';
import {
	blankTeamOption,
	buildTeamOptions,
	rankTeams,
	SUGGEST_MIN_CHARS,
	type TeamOption,
} from '../lib/team-suggestions';
import { HqContainerNotice } from './hq-container-notice';
import { ProjectPlanUpload } from './project-plan-upload';
import {
	agentRosterRows,
	marketplaceRosterRows,
	type TeamRosterRow,
	TeamRosterTable,
	templateRosterRows,
} from './team-roster-table';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { DialogContent } from './ui/dialog';
import { Input } from './ui/input';
import { Tabs } from './ui/tabs';
import { Textarea } from './ui/textarea';

interface CreateProjectWithTeamDialogProps {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	/**
	 * Preselect a marketplace team by slug (e.g. when opened from the marketplace's
	 * "Launch new project" action). The dialog opens with that team confirmed.
	 */
	initialMarketplaceSlug?: string;
}

/**
 * Exactly one source backs the new team: a marketplace team (provisioned directly
 * from its def), a catalog template, or an existing team to clone (snapshotted
 * into a fresh template server-side).
 */
type Selection =
	| { kind: 'marketplace'; slug: string }
	| { kind: 'template'; id: string }
	| { kind: 'team'; id: string }
	| null;

/**
 * Card highlight for the picked team. A selected card gets the app's "active"
 * treatment — a bold inverse ring + filled tint — so the choice reads clearly at
 * a glance; unselected cards keep the hairline border with a hover cue.
 */
function cardStateClass(selected: boolean): string {
	return selected
		? 'border-inverse hover:border-inverse ring-2 ring-inverse bg-surface-2'
		: 'hover:border-border-strong';
}

/** The stable `data-testid` for a team card, keyed by its source kind. */
function teamCardTestId(option: TeamOption): string {
	return option.kind === 'marketplace'
		? `marketplace-team-card-${option.slug}`
		: option.kind === 'template'
			? `team-type-card-${option.name}`
			: `source-team-card-${option.slug}`;
}

function TeamCard({
	option,
	selected,
	onActivate,
	mode = 'select',
	className = '',
}: {
	option: TeamOption;
	selected: boolean;
	onActivate: () => void;
	/**
	 * What the card does when clicked, which also decides how it announces itself.
	 * `select` toggles the choice in place (the entry step's suggestions and the
	 * confirmed team) and is a pressed-state control; `open` navigates to the team's
	 * detail (the browse list), so `aria-pressed` would be a lie — an already-chosen
	 * team is marked `aria-current` and given a chevron instead.
	 */
	mode?: 'select' | 'open';
	className?: string;
}) {
	return (
		<button
			type="button"
			onClick={onActivate}
			className={`text-left w-full ${className}`}
			data-testid={teamCardTestId(option)}
			aria-pressed={mode === 'select' ? selected : undefined}
			aria-current={mode === 'open' && selected ? 'true' : undefined}
		>
			<Card className={`p-3 h-full transition-colors ${cardStateClass(selected)}`}>
				<h3 className="text-[14px] font-medium mb-1">{option.name}</h3>
				{option.description && (
					<p className="text-[12px] text-text-2 mb-2 line-clamp-2">{option.description}</p>
				)}
				<p className="text-[11px] text-text-2 flex items-center gap-1">
					{option.meta}
					{mode === 'open' && <ChevronRight className="w-3.5 h-3.5 text-text-3" />}
				</p>
			</Card>
		</button>
	);
}

/** A spinner row, matching the dialog's other loading states. */
function LoadingRow({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 text-text-2 text-[13px] py-4">
			<Loader2 className="w-4 h-4 animate-spin" /> {label}
		</div>
	);
}

/**
 * The picked team, opened inside the dialog: what it is and every role it staffs,
 * so the choice can be made without leaving the flow for the marketplace page.
 *
 * The roster comes from a different place per source, so all three hooks are called
 * unconditionally and disabled by their own guards (`enabled` on an empty id) rather
 * than branching around them:
 *   - marketplace → the full team def (the catalog index carries no roster),
 *   - template    → the already-loaded template's agent types (no fetch),
 *   - team        → that project's live hired agents.
 */
function TeamDetail({
	option,
	onBack,
	onSelect,
}: {
	option: TeamOption;
	onBack: () => void;
	onSelect: () => void;
}) {
	const marketplace = useMarketplaceTeam(option.kind === 'marketplace' ? option.slug : '');
	const { data: templates } = useTeamTemplates();
	const agents = useAgents(option.kind === 'team' ? option.projectSlug : '');

	const template = option.kind === 'template' ? templates?.find((t) => t.id === option.id) : null;

	let rows: TeamRosterRow[] = [];
	let loading = false;
	let failed = false;
	if (option.kind === 'marketplace') {
		loading = marketplace.isLoading;
		failed = !!marketplace.error;
		if (marketplace.data) rows = marketplaceRosterRows(marketplace.data);
	} else if (option.kind === 'template') {
		loading = !templates;
		if (template) rows = templateRosterRows(template.agent_types);
	} else {
		loading = agents.isLoading;
		failed = !!agents.error;
		if (agents.data) rows = agentRosterRows(agents.data);
	}

	// A template's roster is its Captain plus its agent types, so "Captain only" is a
	// one-row roster rather than an empty one.
	const captainOnly = option.kind === 'template' && rows.length === 1;
	const version = option.kind === 'marketplace' ? marketplace.data?.version : undefined;

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4" data-testid="team-detail">
			<div className="shrink-0">
				<button
					type="button"
					onClick={onBack}
					data-testid="team-detail-back"
					className="inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text-1 transition-colors"
				>
					<ArrowLeft className="w-4 h-4" /> Back to teams
				</button>
				<div className="mt-3 flex items-center gap-2">
					<h3 className="text-[15px] font-medium">{option.name}</h3>
					{version !== undefined && <Badge color="neutral">v{version}</Badge>}
				</div>
				{option.description && <p className="mt-1 text-[13px] text-text-2">{option.description}</p>}
				{option.kind === 'team' && (
					<p className="mt-1 text-[12.5px] text-text-2">
						Starting from this team copies its roles and prompts into a brand-new team. The original
						is untouched.
					</p>
				)}
			</div>
			{/* No negative-margin gutter here (unlike the card grid): a roster row has
			    no ring to keep off the clip edge, and the bleed would push the detail
			    4px wider than its container. */}
			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<LoadingRow label="Loading the roster…" />
				) : failed ? (
					<p className="text-[12.5px] text-text-3 py-4">Couldn’t load this team’s roster.</p>
				) : rows.length === 0 ? (
					<p className="text-[12.5px] text-text-3 py-4">No agents hired yet.</p>
				) : (
					<>
						<p className="text-[13px] font-medium text-text-1 mb-1">
							Roster ({rows.length} {rows.length === 1 ? 'role' : 'roles'})
						</p>
						<TeamRosterTable rows={rows} testId="team-detail-roster" />
						{captainOnly && (
							<p className="mt-3 text-[12.5px] text-text-3">
								Start from scratch - hire roles as you need them.
							</p>
						)}
					</>
				)}
			</div>
			{/* Confirming is the only action here - the create actions live on the entry
			    step. Full-width on mobile, right-aligned from sm: up, matching that
			    step's footer. */}
			<div className="shrink-0 flex flex-col sm:flex-row sm:justify-end">
				<Button type="button" onClick={onSelect} data-testid="team-detail-select">
					<Check className="w-4 h-4" />
					Select team
				</Button>
			</div>
		</div>
	);
}

/**
 * Projects-primary "New project": each project owns its own team. A progressive
 * flow — describe the project (name + description + optional plan), pick from
 * up-to-2 suggested teams ranked from that text, or open the full tabbed catalog
 * via "View all teams". From the catalog a card opens that team's detail (its
 * roster) and "Select team" confirms it back on the entry step, where the
 * Create now / Plan with the CEO actions live.
 */
export function CreateProjectWithTeamDialog({
	open,
	onOpenChange,
	initialMarketplaceSlug,
}: CreateProjectWithTeamDialogProps) {
	const { data: templates, isLoading } = useTeamTemplates();
	const { data: marketplaceTeams } = useMarketplaceTeams();
	const { projects } = useAllVisibleProjects();
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [projectPlan, setProjectPlan] = useState('');
	const [projectPlanFilename, setProjectPlanFilename] = useState<string | null>(null);
	const [selection, setSelection] = useState<Selection>(null);
	const [step, setStep] = useState<'entry' | 'all'>('entry');
	/**
	 * The team whose detail screen is open, by `TeamOption.key`. Held as the key
	 * rather than the option itself so it always resolves against the live option
	 * list — a refetched catalog or an archived project can't strand a stale copy.
	 */
	const [detailKey, setDetailKey] = useState<string | null>(null);
	const [tab, setTab] = useState<'new' | 'copy'>('new');
	const [search, setSearch] = useState('');

	// Every fresh open resets the navigation state and either preselects the
	// marketplace team (from the marketplace launch action) or clears the choice.
	useEffect(() => {
		if (!open) return;
		setStep('entry');
		setDetailKey(null);
		setTab('new');
		setSearch('');
		setSelection(
			initialMarketplaceSlug ? { kind: 'marketplace', slug: initialMarketplaceSlug } : null,
		);
	}, [open, initialMarketplaceSlug]);

	// This dialog outlives a navigation whenever its host is shell chrome:
	// `ProjectRail` is rendered by `ShellChrome` above the `<Outlet />`
	// (routes/__root.tsx), so a client-side navigation swaps the page underneath
	// while the modal keeps covering it. That is reachable from inside the dialog
	// — the blocked state's "View container" link — and from outside it, via the
	// Cmd/Ctrl+K palette, which opens on top of an open modal. The invariant
	// belongs to the modal rather than to whichever host owns the boolean, so the
	// next host to mount it can't forget.
	useCloseOnRouteChange(open, () => onOpenChange(false));

	const createProject = useCreateProjectWithTeam();
	const startIntake = useStartProjectIntake();
	const navigate = useNavigate();
	const hq = useHqProject();
	const hqHealth = useContainerHealth(hq);
	// Project intake/creation is CEO-driven, but a stopped HQ container is no
	// blocker — the intake run lazy-starts it. Block the form only on errors and
	// in-flight transitions.
	const blockedHealth =
		hqHealth && hqHealth.kind !== 'healthy' && hqHealth.kind !== 'stopped' ? hqHealth : null;

	// The unified option list across the three sources. HQ (the internal team) is
	// already excluded from `projects` by useAllVisibleProjects.
	const options = useMemo(
		() =>
			buildTeamOptions(
				marketplaceTeams ?? [],
				templates ?? [],
				projects.map((p) => ({
					id: p.team_id,
					slug: p.team_slug,
					projectSlug: p.slug,
					name: p.team_name,
					agent_count: p.agent_count,
				})),
			),
		[marketplaceTeams, templates, projects],
	);
	const newOptions = useMemo(() => options.filter((o) => o.group === 'new'), [options]);
	const copyOptions = useMemo(() => options.filter((o) => o.group === 'copy'), [options]);
	const showTabs = copyOptions.length > 0;

	const pending = createProject.isPending || startIntake.isPending;
	const canSubmit =
		name.trim().length > 0 && description.trim().length > 0 && !!selection && !pending;
	const error = createProject.error || startIntake.error;

	// The chosen source as request fields; every create path spreads these.
	const sourceFields =
		selection?.kind === 'marketplace'
			? { marketplace_slug: selection.slug }
			: selection?.kind === 'template'
				? { template_id: selection.id }
				: selection?.kind === 'team'
					? { source_team_id: selection.id }
					: null;

	function isSelected(option: TeamOption): boolean {
		if (!selection) return false;
		if (option.kind === 'marketplace')
			return selection.kind === 'marketplace' && selection.slug === option.slug;
		if (option.kind === 'template')
			return selection.kind === 'template' && selection.id === option.id;
		return selection.kind === 'team' && selection.id === option.id;
	}
	function optionToSelection(option: TeamOption): Selection {
		if (option.kind === 'marketplace') return { kind: 'marketplace', slug: option.slug };
		if (option.kind === 'template') return { kind: 'template', id: option.id };
		return { kind: 'team', id: option.id };
	}
	const selectedOption = options.find((o) => isSelected(o)) ?? null;

	// A detail is only ever opened from the browse list, so it always sits on top of
	// step === 'all' and its Back returns there. An option that vanished underneath
	// us (an archived project, a refetched catalog) falls back to the list.
	const detailOption = detailKey ? (options.find((o) => o.key === detailKey) ?? null) : null;
	const view: 'entry' | 'all' | 'detail' = detailOption ? 'detail' : step;

	/** The only place the browse flow commits a choice. */
	function confirmDetail() {
		if (!detailOption) return;
		setSelection(optionToSelection(detailOption));
		setDetailKey(null);
		setStep('entry');
	}

	// Entry step: prompt until the description has signal, then up-to-2 ranked
	// suggestions. When nothing clears the ranker's relevance floor, offer Blank
	// rather than the first two catalog entries - a card under "Suggested teams" is
	// read as a match, and the old fallback made whatever sorted first look like one.
	const showPrompt = description.trim().length < SUGGEST_MIN_CHARS;
	const ranked = rankTeams(`${name} ${description}`, options, 2);
	const blank = blankTeamOption(newOptions);
	const suggestions = ranked.length > 0 ? ranked : blank ? [blank] : newOptions.slice(0, 2);

	// All-teams step: the active tab's list, filtered by the search box.
	const activeGroup = showTabs ? tab : 'new';
	const activeOptions = activeGroup === 'copy' ? copyOptions : newOptions;
	const query = search.trim().toLowerCase();
	const filtered = query
		? activeOptions.filter((o) => `${o.name} ${o.description}`.toLowerCase().includes(query))
		: activeOptions;

	function reset() {
		setName('');
		setDescription('');
		setProjectPlan('');
		setProjectPlanFilename(null);
		setSelection(null);
		setStep('entry');
		setDetailKey(null);
		setTab('new');
		setSearch('');
	}

	async function handleCreateNow() {
		if (!sourceFields) return;
		const res = await createProject.mutateAsync({
			name: name.trim(),
			description: description.trim(),
			initial_project_plan: projectPlan.trim() || undefined,
			...sourceFields,
		});
		setActiveTeamSlug(res.team_slug);
		onOpenChange(false);
		reset();
		// The project + team are created directly. Land on the task list rather than a
		// single task: the CEO's "Set up the team" task is the project's first task and
		// the default work-order sort puts it on top (unblocked before blocked), with
		// the Captain's planning task visible below it as blocked on it.
		navigate({ to: '/projects/$projectId/tasks', params: { projectId: res.slug } });
	}

	async function handlePlanWithCeo() {
		if (!sourceFields) return;
		const res = await startIntake.mutateAsync({
			name: name.trim(),
			description: description.trim(),
			initial_project_plan: projectPlan.trim() || undefined,
			...sourceFields,
		});
		onOpenChange(false);
		reset();
		// No team or project is created yet — the conversation lives in HQ; land on
		// the CEO's intake thread, where the project + team are created on approval.
		navigate({
			to: '/projects/$projectId/tasks/$taskId',
			params: {
				projectId: res.project_slug,
				taskId: res.intake_task_identifier.toLowerCase(),
			},
		});
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent
				size={view === 'entry' ? 'lg' : view === 'all' ? 'xl' : '2xl'}
				data-testid="create-project-dialog"
			>
				<Dialog.Title className="shrink-0 text-base font-medium mb-1 pr-8">
					New project
				</Dialog.Title>
				{hq && blockedHealth ? (
					<>
						<Dialog.Description className="sr-only">
							Waiting for the HQ container before a project can be created.
						</Dialog.Description>
						<HqContainerNotice
							health={blockedHealth}
							description="A new project is scoped by the CEO in HQ, so it can't be created until the HQ container is running."
						/>
					</>
				) : (
					<>
						<Dialog.Description
							className={view === 'entry' ? 'shrink-0 text-sm text-text-2 mb-4' : 'sr-only'}
						>
							{view === 'detail'
								? `Roster and details for the ${detailOption?.name ?? ''} team.`
								: view === 'all'
									? 'Choose a team to staff this project.'
									: 'Each project gets its own team. Name it, describe it, and we’ll suggest a team to staff it.'}
						</Dialog.Description>
						{view === 'entry' ? (
							// shrink-0, not the flex default: the description Textarea and the plan
							// upload are themselves scroll containers, so their flex auto-minimum
							// size is 0 and a shrinking form would collapse *them* instead of
							// letting the dialog scroll. Pinning the form pushes any overflow up to
							// DialogContent's own overflow-y-auto, which is what should scroll here.
							<form
								onSubmit={(e) => {
									e.preventDefault();
									void handleCreateNow();
								}}
								className="flex shrink-0 flex-col gap-4"
							>
								<Input
									label="Project name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="e.g. Marketing Site"
									required
								/>
								<Textarea
									label="Description"
									value={description}
									onChange={(e) => setDescription(e.target.value)}
									required
									rows={4}
									className="resize-none! overflow-y-auto"
									placeholder="What is this project? Domain, users, and the core problem it solves."
								/>
								<ProjectPlanUpload
									value={projectPlan}
									filename={projectPlanFilename}
									onChange={(v, f) => {
										setProjectPlan(v);
										setProjectPlanFilename(f);
									}}
								/>
								{selectedOption ? (
									<div data-testid="selected-team-card">
										<div className="flex items-center justify-between mb-2">
											<span className="text-[13px] font-medium text-text-1">Selected team</span>
											<button
												type="button"
												onClick={() => setStep('all')}
												className="text-[12.5px] text-accent hover:underline inline-flex items-center gap-1"
												data-testid="choose-different-team"
											>
												Choose a different team <ArrowRight className="w-3 h-3" />
											</button>
										</div>
										<TeamCard option={selectedOption} selected onActivate={() => setStep('all')} />
									</div>
								) : (
									<div>
										<div className="flex items-center justify-between mb-2">
											<span className="text-[13px] font-medium text-text-1">Suggested teams</span>
											<button
												type="button"
												onClick={() => setStep('all')}
												className="text-[12.5px] text-accent hover:underline inline-flex items-center gap-1"
												data-testid="view-all-teams"
											>
												View all teams <ArrowRight className="w-3 h-3" />
											</button>
										</div>
										{isLoading ? (
											<LoadingRow label="Loading teams…" />
										) : showPrompt ? (
											<p className="rounded-md border border-dashed border-border-strong px-3 py-3 text-center text-[12.5px] text-text-3">
												Describe your project above to see suggested teams.
											</p>
										) : (
											<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
												{suggestions.map((o, i) => (
													<TeamCard
														key={o.key}
														option={o}
														selected={isSelected(o)}
														onActivate={() => setSelection(optionToSelection(o))}
														className={i === 1 ? 'hidden sm:block' : ''}
													/>
												))}
											</div>
										)}
									</div>
								)}
								{error && (
									<p className="text-[13px] text-danger">
										{(error as { message?: string }).message || 'Failed to create project'}
									</p>
								)}
								{/* The submit actions belong to the entry step alone - the browse and
								    detail screens are for picking, and confirm via "Select team". Gating
								    the row here also unmounts the mod+Enter binding on those screens. */}
								{selection && (
									<div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-2">
										<Button
											type="button"
											variant="secondary"
											onClick={handlePlanWithCeo}
											disabled={!canSubmit}
											data-testid="plan-with-ceo-submit"
										>
											{startIntake.isPending ? (
												<Loader2 className="w-4 h-4 animate-spin" />
											) : (
												<MessagesSquare className="w-4 h-4" />
											)}
											Plan with the CEO
										</Button>
										<Button
											type="submit"
											shortcut="mod+Enter"
											disabled={!canSubmit}
											data-testid="create-project-submit"
										>
											{createProject.isPending ? (
												<Loader2 className="w-4 h-4 animate-spin" />
											) : (
												<Sparkles className="w-4 h-4" />
											)}
											Create now
										</Button>
									</div>
								)}
							</form>
						) : view === 'detail' && detailOption ? (
							<TeamDetail
								option={detailOption}
								onBack={() => setDetailKey(null)}
								onSelect={confirmDetail}
							/>
						) : (
							<div className="flex min-h-0 flex-1 flex-col gap-4">
								<button
									type="button"
									onClick={() => setStep('entry')}
									data-testid="all-teams-back"
									className="shrink-0 self-start inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text-1 transition-colors"
								>
									<ArrowLeft className="w-4 h-4" /> Back
								</button>
								<span className="shrink-0 text-[13px] font-medium text-text-1">Choose a team</span>
								{showTabs && (
									<Tabs
										value={tab}
										onValueChange={(k) => setTab(k as 'new' | 'copy')}
										activeSurface="bg-surface"
										aria-label="Team source"
										className="shrink-0"
										items={[
											{
												key: 'new',
												label: 'New team',
												count: newOptions.length,
												testId: 'team-tab-new',
											},
											{
												key: 'copy',
												label: 'Copy existing team',
												count: copyOptions.length,
												testId: 'team-tab-copy',
											},
										]}
									/>
								)}
								<Input
									icon={<Search className="w-3.5 h-3.5" />}
									type="search"
									aria-label="Search teams"
									placeholder="Search teams…"
									value={search}
									wrapperClassName="shrink-0"
									onChange={(e) => setSearch(e.target.value)}
									data-testid="team-search"
								/>
								{isLoading ? (
									<LoadingRow label="Loading teams…" />
								) : (
									// The only item allowed to shrink, so it absorbs the whole squeeze
									// and scrolls rather than collapsing. `-m-1 p-1` (not just the
									// horizontal `-mx-1 px-1` this had) keeps the selected card's
									// ring-2 off the clip edge on all four sides.
									<div
										className="min-h-0 flex-1 overflow-y-auto -m-1 p-1"
										data-testid="team-list-scroll"
									>
										{filtered.length === 0 ? (
											<p className="text-[12.5px] text-text-3 py-8 text-center">
												No teams match your search.
											</p>
										) : (
											<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
												{filtered.map((o) => (
													<TeamCard
														key={o.key}
														option={o}
														mode="open"
														selected={isSelected(o)}
														onActivate={() => setDetailKey(o.key)}
													/>
												))}
											</div>
										)}
									</div>
								)}
							</div>
						)}
					</>
				)}
			</DialogContent>
		</Dialog.Root>
	);
}
