import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { setActiveTeamSlug } from '../hooks/use-active-team-slug';
import { useTeamTemplates } from '../hooks/use-team-templates';
import { useCreateTeam } from '../hooks/use-teams';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
import { Input } from './ui/input';

interface CreateTeamDialogProps {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}

export function CreateTeamDialog({ open, onOpenChange }: CreateTeamDialogProps) {
	const { data: templates, isLoading } = useTeamTemplates();
	const [name, setName] = useState('');
	const [templateId, setTemplateId] = useState<string | null>(null);
	const createTeam = useCreateTeam();
	const navigate = useNavigate();

	const canSubmit = name.trim().length > 0 && !!templateId && !createTeam.isPending;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!name.trim() || !templateId) return;
		const team = await createTeam.mutateAsync({ name: name.trim(), template_id: templateId });
		setActiveTeamSlug(team.slug);
		onOpenChange(false);
		setName('');
		setTemplateId(null);
		navigate({ to: '/teams/$teamId/tasks', params: { teamId: team.slug } });
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.lg}>
					<Dialog.Title className="text-base font-medium mb-1">New team</Dialog.Title>
					<Dialog.Description className="text-sm text-text-muted mb-4">
						Pick a team type to start from. Its agents are provisioned immediately; the new team's
						Captain runs a coherence review in the background.
					</Dialog.Description>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input
							label="Team name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. Web, Research, Marketing"
							required
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
						{createTeam.error && (
							<p className="text-[13px] text-accent-red">
								{(createTeam.error as { message?: string }).message || 'Failed to create team'}
							</p>
						)}
						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!canSubmit} data-testid="create-team-submit">
								{createTeam.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Create team
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
