import { GoalStatus, OPERATIONS_PROJECT_SLUG } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type GoalWithProject, useCreateGoal, useUpdateGoal } from '../hooks/use-goals';
import { useProjects } from '../hooks/use-projects';
import { MentionTextarea } from './mention-textarea';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
import { Input } from './ui/input';

interface GoalDialogProps {
	companyId: string;
	open: boolean;
	onOpenChange: (v: boolean) => void;
	goal?: GoalWithProject;
}

export function GoalDialog({ companyId, open, onOpenChange, goal }: GoalDialogProps) {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [projectId, setProjectId] = useState<string>('');
	const [status, setStatus] = useState<string>(GoalStatus.Active);
	const { data: projects } = useProjects(companyId);
	const createGoal = useCreateGoal(companyId);
	const updateGoal = useUpdateGoal(companyId, goal?.id ?? '');

	useEffect(() => {
		if (open) {
			setTitle(goal?.title ?? '');
			setDescription(goal?.description ?? '');
			setProjectId(goal?.project_id ?? '');
			setStatus(goal?.status ?? GoalStatus.Active);
		}
	}, [open, goal]);

	const isEdit = !!goal;
	const isPending = createGoal.isPending || updateGoal.isPending;
	const canSubmit = title.trim().length > 0 && !isPending;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!canSubmit) return;
		if (isEdit && goal) {
			await updateGoal.mutateAsync({
				title: title.trim(),
				description: description.trim(),
				project_id: projectId || null,
				status: status as GoalStatus,
			});
		} else {
			await createGoal.mutateAsync({
				title: title.trim(),
				description: description.trim() || undefined,
				project_id: projectId || null,
			});
		}
		onOpenChange(false);
	}

	const nonInternalProjects = (projects ?? []).filter((p) => p.slug !== OPERATIONS_PROJECT_SLUG);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.lg}>
					<Dialog.Title className="text-base font-medium mb-1">
						{isEdit ? 'Edit goal' : 'New goal'}
					</Dialog.Title>
					<p className="text-sm text-text-muted mb-4">
						{isEdit
							? 'Changes trigger the CEO to re-review plans.'
							: 'The CEO will review all plans against this goal.'}
					</p>
					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<Input
							label="Title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							required
							placeholder="Ship a public v1 by end of Q3"
						/>
						<MentionTextarea
							companyId={companyId}
							projectSlug={projects?.find((p) => p.id === projectId)?.slug}
							label="Description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={4}
							placeholder="Context, constraints, and how you'll know this goal is met."
						/>
						<label className="flex flex-col gap-1.5">
							<span className="text-sm text-text-muted">Scope</span>
							<select
								value={projectId}
								onChange={(e) => setProjectId(e.target.value)}
								className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
							>
								<option value="">Company-wide</option>
								{nonInternalProjects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</select>
						</label>
						{isEdit && (
							<label className="flex flex-col gap-1.5">
								<span className="text-sm text-text-muted">Status</span>
								<select
									value={status}
									onChange={(e) => setStatus(e.target.value)}
									className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
								>
									<option value={GoalStatus.Active}>Active</option>
									<option value={GoalStatus.Achieved}>Achieved</option>
									<option value={GoalStatus.Archived}>Archived</option>
								</select>
							</label>
						)}
						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!canSubmit}>
								{isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								{isEdit ? 'Save' : 'Create'}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
