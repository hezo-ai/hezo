import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, Loader2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAgents } from '../hooks/use-agents';
import { useProjectMeta } from '../hooks/use-projects';
import { useCreateTask } from '../hooks/use-tasks';
import { MentionTextarea } from './mention-textarea';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
import { Input } from './ui/input';

interface CreateTaskDialogProps {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateTaskDialog({ projectId, open, onOpenChange }: CreateTaskDialogProps) {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [assigneeId, setAssigneeId] = useState('');
	const [priority, setPriority] = useState('medium');
	const [moreOpen, setMoreOpen] = useState(false);
	const project = useProjectMeta(projectId);
	const { data: agents } = useAgents(projectId);
	const createTask = useCreateTask(projectId);
	const navigate = useNavigate();

	const isInternalProject = project?.is_internal ?? false;
	const captainAgent = useMemo(() => agents?.find((a) => a.slug === CAPTAIN_AGENT_SLUG), [agents]);
	const selectableAgents = useMemo(() => {
		if (!agents) return [];
		if (isInternalProject) {
			return captainAgent ? [captainAgent] : [];
		}
		return agents.filter((a) => a.admin_status !== 'disabled');
	}, [agents, captainAgent, isInternalProject]);

	const priorityLabel = priority.charAt(0).toUpperCase() + priority.slice(1);
	const summaryLabel = `${priorityLabel} priority · ${project?.name ?? projectId}`;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await createTask.mutateAsync({
			title,
			description: description || undefined,
			assignee_id: assigneeId || undefined,
			priority,
		});
		onOpenChange(false);
		setTitle('');
		setDescription('');
		navigate({
			to: '/projects/$projectId/tasks/$taskId',
			params: {
				projectId: result.project_slug ?? projectId,
				taskId: result.identifier.toLowerCase(),
			},
		});
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.lg}>
					<div className="flex items-center justify-between mb-4">
						<Dialog.Title className="text-lg font-semibold">Create Task</Dialog.Title>
						<Dialog.Close asChild>
							<button
								type="button"
								className="text-text-muted hover:text-text p-2 -m-2"
								aria-label="Close"
							>
								<X className="w-4 h-4" />
							</button>
						</Dialog.Close>
					</div>

					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input
							label="Title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							required
						/>
						<MentionTextarea
							projectId={projectId}
							projectSlug={project?.slug}
							label="Description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Optional"
						/>

						<label className="flex flex-col gap-1.5">
							<span className="text-sm text-text-muted">Assignee *</span>
							<select
								value={assigneeId}
								onChange={(e) => setAssigneeId(e.target.value)}
								required
								className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
							>
								<option value="">Select assignee</option>
								{selectableAgents.map((a) => (
									<option key={a.id} value={a.id}>
										{a.title}
									</option>
								))}
							</select>
						</label>

						<div className="flex flex-col gap-3">
							<button
								type="button"
								onClick={() => setMoreOpen((o) => !o)}
								aria-expanded={moreOpen}
								data-testid="create-task-more-toggle"
								className="flex items-center gap-2 self-start text-xs text-text-muted hover:text-text cursor-pointer"
							>
								<ChevronDown
									className={`w-3.5 h-3.5 text-text-subtle shrink-0 transition-transform ${
										moreOpen ? '' : '-rotate-90'
									}`}
								/>
								<span className="truncate">{summaryLabel}</span>
							</button>
							{moreOpen && (
								<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
									<label className="flex flex-col gap-1.5">
										<span className="text-sm text-text-muted">Priority</span>
										<select
											value={priority}
											onChange={(e) => setPriority(e.target.value)}
											className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
										>
											<option value="low">Low</option>
											<option value="medium">Medium</option>
											<option value="high">High</option>
											<option value="urgent">Urgent</option>
										</select>
									</label>
								</div>
							)}
						</div>

						{createTask.error && (
							<p className="text-sm text-accent-red">
								{(createTask.error as { message: string }).message}
							</p>
						)}

						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!title.trim() || !assigneeId || createTask.isPending}>
								{createTask.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Create
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
