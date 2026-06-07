import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { setActiveTeamSlug } from '../hooks/use-active-team-slug';
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
 * type, name the project, describe it — the server provisions a fresh team
 * (roster from the type, named after the project) and opens the intake on it;
 * we drop the operator into the new team's intake conversation.
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
	const navigate = useNavigate();

	const canSubmit =
		name.trim().length > 0 &&
		description.trim().length > 0 &&
		!!templateId &&
		!createProject.isPending;

	function reset() {
		setName('');
		setDescription('');
		setTemplateId(null);
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim() || !description.trim() || !templateId) return;
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

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.lg}>
					<Dialog.Title className="text-base font-medium mb-1">New project</Dialog.Title>
					<Dialog.Description className="text-sm text-text-muted mb-4">
						Each project gets its own team. Pick a team type to staff it; the new team's Captain
						reviews your requirements and confirms the roster before opening the project.
					</Dialog.Description>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
															? 'Captain + Coach'
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
						{createProject.error && (
							<p className="text-[13px] text-accent-red">
								{(createProject.error as { message?: string }).message ||
									'Failed to create project'}
							</p>
						)}
						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!canSubmit} data-testid="create-project-submit">
								{createProject.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Create project
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
