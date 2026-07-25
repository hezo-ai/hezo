import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Loader2, MessagesSquare, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { setActiveTeamSlug } from '../hooks/use-active-team-slug';
import { useContainerHealth } from '../hooks/use-container-health';
import { useMarketplaceTeams } from '../hooks/use-marketplace';
import { useStartProjectIntake } from '../hooks/use-project-intake';
import {
	useAllVisibleProjects,
	useCreateProjectWithTeam,
	useHqProject,
} from '../hooks/use-projects';
import { useTeamTemplates } from '../hooks/use-team-templates';
import {
	buildTeamOptions,
	rankTeams,
	SUGGEST_MIN_CHARS,
	type TeamOption,
} from '../lib/team-suggestions';
import { HqContainerNotice } from './hq-container-notice';
import { ProjectPlanUpload } from './project-plan-upload';
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
	onSelect,
	className = '',
}: {
	option: TeamOption;
	selected: boolean;
	onSelect: () => void;
	className?: string;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={`text-left w-full ${className}`}
			data-testid={teamCardTestId(option)}
			aria-pressed={selected}
		>
			<Card className={`p-3 h-full transition-colors ${cardStateClass(selected)}`}>
				<h3 className="text-[14px] font-medium mb-1">{option.name}</h3>
				{option.description && (
					<p className="text-[12px] text-text-2 mb-2 line-clamp-2">{option.description}</p>
				)}
				<p className="text-[11px] text-text-2">{option.meta}</p>
			</Card>
		</button>
	);
}

/**
 * Projects-primary "New project": each project owns its own team. A progressive
 * two-step flow — describe the project (name + description + optional plan), pick
 * from up-to-2 suggested teams ranked from that text, or open the full tabbed
 * catalog via "View all teams". The Create now / Plan with the CEO actions appear
 * only once a team is selected.
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
	const [tab, setTab] = useState<'new' | 'copy'>('new');
	const [search, setSearch] = useState('');

	// Every fresh open resets the navigation state and either preselects the
	// marketplace team (from the marketplace launch action) or clears the choice.
	useEffect(() => {
		if (!open) return;
		setStep('entry');
		setTab('new');
		setSearch('');
		setSelection(
			initialMarketplaceSlug ? { kind: 'marketplace', slug: initialMarketplaceSlug } : null,
		);
	}, [open, initialMarketplaceSlug]);

	const createProject = useCreateProjectWithTeam();
	const startIntake = useStartProjectIntake();
	const navigate = useNavigate();
	const hq = useHqProject();
	const hqHealth = useContainerHealth(hq);
	// Project intake/creation is driven by the CEO in HQ, so it can't proceed
	// until the HQ container is running. Block the form until then.
	const blockedHealth = hqHealth && hqHealth.kind !== 'healthy' ? hqHealth : null;

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

	// Entry step: prompt until the description has signal, then up-to-2 ranked
	// suggestions (falling back to the first team types when nothing matches).
	const showPrompt = description.trim().length < SUGGEST_MIN_CHARS;
	const ranked = rankTeams(`${name} ${description}`, options, 2);
	const suggestions = ranked.length > 0 ? ranked : newOptions.slice(0, 2);

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
		// The project + team are created directly; land on the Captain's planning task.
		navigate({
			to: '/projects/$projectId/tasks/$taskId',
			params: {
				projectId: res.slug,
				taskId: res.planning_task_identifier.toLowerCase(),
			},
		});
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
			<DialogContent size={step === 'all' ? 'xl' : 'lg'}>
				<Dialog.Title className="text-base font-medium mb-1 pr-8">New project</Dialog.Title>
				{hq && blockedHealth ? (
					<>
						<Dialog.Description className="sr-only">
							Waiting for the HQ container before a project can be created.
						</Dialog.Description>
						<HqContainerNotice
							health={blockedHealth}
							slug={hq.slug}
							description="A new project is scoped by the CEO in HQ, so it can't be created until the HQ container is running."
						/>
					</>
				) : (
					<>
						<Dialog.Description className={step === 'all' ? 'sr-only' : 'text-sm text-text-2 mb-4'}>
							{step === 'all'
								? 'Choose a team to staff this project.'
								: 'Each project gets its own team. Name it, describe it, and we’ll suggest a team to staff it.'}
						</Dialog.Description>
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void handleCreateNow();
							}}
							className="flex flex-col gap-4"
						>
							{step === 'entry' ? (
								<>
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
											<TeamCard option={selectedOption} selected onSelect={() => setStep('all')} />
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
												<div className="flex items-center gap-2 text-text-2 text-[13px] py-4">
													<Loader2 className="w-4 h-4 animate-spin" /> Loading teams…
												</div>
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
															onSelect={() => setSelection(optionToSelection(o))}
															className={i === 1 ? 'hidden sm:block' : ''}
														/>
													))}
												</div>
											)}
										</div>
									)}
								</>
							) : (
								<>
									<button
										type="button"
										onClick={() => setStep('entry')}
										data-testid="all-teams-back"
										className="inline-flex items-center gap-1 text-[13px] text-text-2 hover:text-text-1 transition-colors"
									>
										<ArrowLeft className="w-4 h-4" /> Back
									</button>
									<span className="text-[13px] font-medium text-text-1">Choose a team</span>
									{showTabs && (
										<Tabs
											value={tab}
											onValueChange={(k) => setTab(k as 'new' | 'copy')}
											activeSurface="bg-surface"
											aria-label="Team source"
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
										onChange={(e) => setSearch(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === 'Enter') e.preventDefault();
										}}
										data-testid="team-search"
									/>
									{isLoading ? (
										<div className="flex items-center gap-2 text-text-2 text-[13px] py-4">
											<Loader2 className="w-4 h-4 animate-spin" /> Loading teams…
										</div>
									) : (
										<div className="max-h-[46vh] overflow-y-auto -mx-1 px-1">
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
															selected={isSelected(o)}
															onSelect={() => setSelection(optionToSelection(o))}
														/>
													))}
												</div>
											)}
										</div>
									)}
								</>
							)}
							{error && (
								<p className="text-[13px] text-danger">
									{(error as { message?: string }).message || 'Failed to create project'}
								</p>
							)}
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
					</>
				)}
			</DialogContent>
		</Dialog.Root>
	);
}
