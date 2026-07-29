import { TERMINAL_TASK_STATUSES } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useState } from 'react';
import { type Task, useTasks, type useUpdateTask } from '../../hooks/use-tasks';
import { Button } from '../ui/button';
import { DialogContent } from '../ui/dialog';
import { SearchableSelect, type SearchableSelectOption } from '../ui/searchable-select';

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	task: Task;
	currentParentIdentifier: string | null;
	updateTask: ReturnType<typeof useUpdateTask>;
}

/**
 * Collect a task and everything beneath it. A task cannot become its own
 * descendant, so the whole sub-tree is ineligible as a destination. The server
 * enforces this regardless; hiding them just keeps the list honest.
 */
function collectSubtree(rootId: string, tasks: Task[]): Set<string> {
	const childrenByParent = new Map<string, string[]>();
	for (const t of tasks) {
		if (!t.parent_task_id) continue;
		const siblings = childrenByParent.get(t.parent_task_id) ?? [];
		siblings.push(t.id);
		childrenByParent.set(t.parent_task_id, siblings);
	}
	const subtree = new Set<string>([rootId]);
	const queue = [rootId];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		for (const childId of childrenByParent.get(id) ?? []) {
			if (subtree.has(childId)) continue;
			subtree.add(childId);
			queue.push(childId);
		}
	}
	return subtree;
}

export function ChangeParentDialog({
	open,
	onOpenChange,
	projectId,
	task,
	currentParentIdentifier,
	updateTask,
}: Props) {
	const [selected, setSelected] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const { data: tasksPage } = useTasks(projectId, { per_page: '200' }, { enabled: open });
	const allTasks = useMemo(() => tasksPage?.data ?? [], [tasksPage]);

	const options = useMemo<SearchableSelectOption[]>(() => {
		const excluded = collectSubtree(task.id, allTasks);
		const terminal = TERMINAL_TASK_STATUSES as readonly string[];
		return allTasks
			.filter((t) => !excluded.has(t.id) && !terminal.includes(t.status))
			.map((t) => ({
				value: t.identifier,
				label: `${t.identifier} · ${t.title}`,
				description: t.status,
			}));
	}, [allTasks, task.id]);

	async function submit(parentTaskId: string | null) {
		setError(null);
		try {
			await updateTask.mutateAsync({ parent_task_id: parentTaskId });
			onOpenChange(false);
			setSelected(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Failed to change the parent');
		}
	}

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					setSelected(null);
					setError(null);
				}
				onOpenChange(next);
			}}
		>
			<DialogContent size="sm">
				<Dialog.Title className="text-lg font-semibold mb-1">Change parent</Dialog.Title>
				<p className="text-xs text-text-3 mb-4">
					{currentParentIdentifier
						? `${task.identifier} is currently a sub-task of ${currentParentIdentifier}.`
						: `${task.identifier} is currently a top-level task.`}
				</p>

				<div className="flex flex-col gap-3">
					<SearchableSelect
						options={options}
						value={selected}
						onChange={setSelected}
						placeholder="Select a parent task…"
						searchPlaceholder="Search tasks…"
						emptyLabel="No eligible tasks"
						testId="change-parent-select"
					/>

					{error && (
						<p className="text-xs text-danger-soft-fg" data-testid="change-parent-error">
							{error}
						</p>
					)}

					<div className="flex flex-wrap items-center justify-end gap-2 pt-1">
						{task.parent_task_id && (
							<Button
								type="button"
								variant="secondary"
								disabled={updateTask.isPending}
								onClick={() => submit(null)}
								data-testid="change-parent-promote"
							>
								Move to top level
							</Button>
						)}
						<Button
							type="button"
							variant="secondary"
							onClick={() => onOpenChange(false)}
							data-testid="change-parent-cancel"
						>
							Cancel
						</Button>
						<Button
							type="button"
							disabled={!selected || updateTask.isPending}
							onClick={() => selected && submit(selected)}
							data-testid="change-parent-save"
						>
							Save
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}
