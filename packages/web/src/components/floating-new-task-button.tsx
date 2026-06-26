import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useActiveProject } from '../hooks/use-active-project';
import { CreateTaskDialog } from './create-task-dialog';
import { Tooltip } from './ui/tooltip';

interface FloatingNewTaskButtonProps {
	/**
	 * Hide the button while another full-screen surface owns the corner — the
	 * mobile nav drawer (which contains both the project rail and the project
	 * menu) or the open CEO chat. The dialog stays mounted so an in-flight create
	 * can still close itself.
	 */
	hidden: boolean;
}

/**
 * A round "+" button that creates a task in the active project. It mirrors the
 * CEO chat launcher's floating treatment but uses the accent fill (vs. the
 * chat's inverse fill) so the two are never confused, and it's pinned to the
 * opposite (bottom-left) corner.
 *
 * Scope: mobile/tablet only (`lg:hidden`). On desktop the persistent project
 * menu is always visible and carries its own "+" next to the Tasks link, so a
 * floating duplicate there would be redundant. It only renders on project-scoped
 * routes (where there's a project to create the task in).
 */
export function FloatingNewTaskButton({ hidden }: FloatingNewTaskButtonProps) {
	const active = useActiveProject();
	const [open, setOpen] = useState(false);

	if (!active) return null;

	return (
		<>
			{!hidden && (
				<Tooltip content="New task" side="right">
					<button
						type="button"
						onClick={() => setOpen(true)}
						data-testid="floating-new-task"
						aria-label="New task"
						className="lg:hidden fixed bottom-4 left-4 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-accent-solid text-accent-solid-fg shadow-lg transition-colors hover:bg-accent-hover"
					>
						<Plus className="h-6 w-6" />
					</button>
				</Tooltip>
			)}
			<CreateTaskDialog projectId={active.slug} open={open} onOpenChange={setOpen} />
		</>
	);
}
