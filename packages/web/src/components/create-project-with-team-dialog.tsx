import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Loader2, MessagesSquare, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { setActiveTeamSlug } from '../hooks/use-active-team-slug';
import { useStartProjectIntake } from '../hooks/use-project-intake';
import { useAllVisibleProjects, useCreateProjectWithTeam } from '../hooks/use-projects';
import { useTeamTemplates } from '../hooks/use-team-templates';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';

interface CreateProjectWithTeamDialogProps {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}

/**
 * Exactly one source backs the new team: either a catalog template or an
 * existing team to clone (snapshotted into a fresh template server-side).
 */
type Selection = { kind: 'template'; id: string } | { kind: 'team'; id: string } | null;

/**
 * Projects-primary "New project": each project owns its own team. Pick a team
 * type, name the project, describe it, then either create it straight away or
 * hand the brief to the CEO, who scopes it with you in HQ before it opens.
 */
export function CreateProjectWithTeamDialog({
	open,
	onOpenChange,
}: CreateProjectWithTeamDialogProps) {
	const { data: templates, isLoading } = useTeamTemplates();
	const { projects } = useAllVisibleProjects();
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [selection, setSelection] = useState<Selection>(null);
	const createProject = useCreateProjectWithTeam();
	const startIntake = useStartProjectIntake();
	const navigate = useNavigate();

	// Existing teams the new project's team can be cloned from, reached through
	// each project. HQ (the internal team) is already excluded by
	// useAllVisibleProjects — snapshotting it would carry the CEO/Coach into the roster.
	const sourceTeams = projects.map((p) => ({
		id: p.team_id,
		slug: p.team_slug,
		name: p.team_name,
		agent_count: p.agent_count,
	}));

	const pending = createProject.isPending || startIntake.isPending;
	const canSubmit =
		name.trim().length > 0 && description.trim().length > 0 && !!selection && !pending;
	const error = createProject.error || startIntake.error;

	// The chosen source as request fields: a template id or a source-team id.
	const sourceFields =
		selection?.kind === 'template'
			? { template_id: selection.id }
			: selection?.kind === 'team'
				? { source_team_id: selection.id }
				: null;

	function reset() {
		setName('');
		setDescription('');
		setSelection(null);
	}

	async function handleCreateNow() {
		if (!sourceFields) return;
		const res = await createProject.mutateAsync({
			name: name.trim(),
			description: description.trim(),
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
			...sourceFields,
		});
		setActiveTeamSlug(res.team_slug);
		onOpenChange(false);
		reset();
		// The conversation lives in HQ; land on the CEO's intake thread.
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
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.lg}>
					<Dialog.Title className="text-base font-medium mb-1">New project</Dialog.Title>
					<Dialog.Description className="text-sm text-text-2 mb-4">
						Each project gets its own team. Pick a team type to staff it, then create it now or let
						the CEO scope it with you first.
					</Dialog.Description>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void handleCreateNow();
						}}
						className="flex flex-col gap-4"
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
							placeholder="What is this project? Domain, users, and the core problem it solves."
						/>
						<div>
							<span className="text-[13px] font-medium text-text-1">Team type</span>
							{isLoading ? (
								<div className="flex items-center gap-2 text-text-2 text-[13px] py-4">
									<Loader2 className="w-4 h-4 animate-spin" /> Loading types…
								</div>
							) : (
								<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
									{(templates ?? []).map((tpl) => {
										const selected = selection?.kind === 'template' && selection.id === tpl.id;
										return (
											<button
												key={tpl.id}
												type="button"
												onClick={() => setSelection({ kind: 'template', id: tpl.id })}
												className="text-left"
												data-testid={`team-type-card-${tpl.name}`}
												aria-pressed={selected}
											>
												<Card
													className={`p-3 h-full transition-colors ${
														selected ? 'border-inverse' : 'hover:border-border-strong'
													}`}
												>
													<h3 className="text-[14px] font-medium mb-1">{tpl.name}</h3>
													{tpl.description && (
														<p className="text-[12px] text-text-2 mb-2 line-clamp-2">
															{tpl.description}
														</p>
													)}
													<p className="text-[11px] text-text-2">
														{tpl.agent_types.length === 0
															? 'Captain only'
															: `${tpl.agent_types.length} agent role${
																	tpl.agent_types.length === 1 ? '' : 's'
																}`}
													</p>
												</Card>
											</button>
										);
									})}
								</div>
							)}
						</div>
						{sourceTeams.length > 0 && (
							<div>
								<span className="text-[13px] font-medium text-text-1">Copy an existing team</span>
								<p className="text-[12px] text-text-2">
									Start from another team's roster. A reusable team type is saved from its current
									setup.
								</p>
								<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
									{sourceTeams.map((team) => {
										const selected = selection?.kind === 'team' && selection.id === team.id;
										return (
											<button
												key={team.id}
												type="button"
												onClick={() => setSelection({ kind: 'team', id: team.id })}
												className="text-left"
												data-testid={`source-team-card-${team.slug}`}
												aria-pressed={selected}
											>
												<Card
													className={`p-3 h-full transition-colors ${
														selected ? 'border-inverse' : 'hover:border-border-strong'
													}`}
												>
													<h3 className="text-[14px] font-medium mb-1">{team.name}</h3>
													<p className="text-[11px] text-text-2">
														{team.agent_count === 0
															? 'No agents yet'
															: `${team.agent_count} agent${team.agent_count === 1 ? '' : 's'}`}
													</p>
												</Card>
											</button>
										);
									})}
								</div>
							</div>
						)}
						{error && (
							<p className="text-[13px] text-danger">
								{(error as { message?: string }).message || 'Failed to create project'}
							</p>
						)}
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
							<Button type="submit" disabled={!canSubmit} data-testid="create-project-submit">
								{createProject.isPending ? (
									<Loader2 className="w-4 h-4 animate-spin" />
								) : (
									<Sparkles className="w-4 h-4" />
								)}
								Create now
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
