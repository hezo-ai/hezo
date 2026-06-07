import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Loader2, MessagesSquare, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { setActiveTeamSlug } from '../hooks/use-active-team-slug';
import { useStartProjectIntake } from '../hooks/use-project-intake';
import { useCreateProjectWithTeam } from '../hooks/use-projects';
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
 * Projects-primary "New project": each project owns its own team. Pick a team
 * type, name the project, describe it, then either create it straight away or
 * hand the brief to the CEO, who scopes it with you in HQ before it opens.
 */
export function CreateProjectWithTeamDialog({
	open,
	onOpenChange,
}: CreateProjectWithTeamDialogProps) {
	const { data: templates, isLoading } = useTeamTemplates();
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const [templateId, setTemplateId] = useState<string | null>(null);
	const createProject = useCreateProjectWithTeam();
	const startIntake = useStartProjectIntake();
	const navigate = useNavigate();

	const pending = createProject.isPending || startIntake.isPending;
	const canSubmit =
		name.trim().length > 0 && description.trim().length > 0 && !!templateId && !pending;
	const error = createProject.error || startIntake.error;

	function reset() {
		setName('');
		setDescription('');
		setTemplateId(null);
	}

	async function handleCreateNow() {
		if (!templateId) return;
		const res = await createProject.mutateAsync({
			name: name.trim(),
			description: description.trim(),
			template_id: templateId,
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
		if (!templateId) return;
		const res = await startIntake.mutateAsync({
			name: name.trim(),
			description: description.trim(),
			template_id: templateId,
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
					<Dialog.Description className="text-sm text-text-muted mb-4">
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
							<span className="text-[13px] font-medium text-text">Team type</span>
							{isLoading ? (
								<div className="flex items-center gap-2 text-text-muted text-[13px] py-4">
									<Loader2 className="w-4 h-4 animate-spin" /> Loading types…
								</div>
							) : (
								<div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
									{(templates ?? []).map((tpl) => {
										const selected = templateId === tpl.id;
										return (
											<button
												key={tpl.id}
												type="button"
												onClick={() => setTemplateId(tpl.id)}
												className="text-left"
												data-testid={`team-type-card-${tpl.name}`}
												aria-pressed={selected}
											>
												<Card
													className={`p-3 h-full transition-colors ${
														selected ? 'border-primary' : 'hover:border-border-hover'
													}`}
												>
													<h3 className="text-[14px] font-medium mb-1">{tpl.name}</h3>
													{tpl.description && (
														<p className="text-[12px] text-text-muted mb-2 line-clamp-2">
															{tpl.description}
														</p>
													)}
													<p className="text-[11px] text-text-muted">
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
						{error && (
							<p className="text-[13px] text-accent-red">
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
