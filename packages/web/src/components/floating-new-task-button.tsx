import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useActiveProject } from '../hooks/use-active-project';
import { useDraggableFab } from '../hooks/use-draggable-fab';
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
 * A round "+" button that opens a create-task dialog with a project picker, so a
 * task can be filed into any project from anywhere. It mirrors the CEO chat
 * launcher's floating treatment but uses the accent fill (vs. the chat's inverse
 * fill) so the two are never confused, and it's pinned to the opposite
 * (bottom-left) corner. The current route's project, if any, is the picker's
 * default.
 *
 * Scope: mobile/tablet only (`lg:hidden`). On desktop the persistent project
 * menu is always visible and carries its own "+" next to the Tasks link, so a
 * floating duplicate there would be redundant. It renders on every mobile route
 * (project-scoped or not) — the dialog's picker supplies the target project.
 *
 * On portrait mobile screens the button is draggable (via `useDraggableFab`)
 * so it can be moved off content it would otherwise cover.
 */
export function FloatingNewTaskButton({ hidden }: FloatingNewTaskButtonProps) {
	const active = useActiveProject();
	const [open, setOpen] = useState(false);
	const fab = useDraggableFab('new-task');

	return (
		<>
			{!hidden && (
				<Tooltip content="New task" side="right">
					<button
						ref={fab.ref}
						type="button"
						onClick={() => setOpen(true)}
						{...fab.handlers}
						style={fab.style}
						data-testid="floating-new-task"
						aria-label="New task"
						className="lg:hidden fixed bottom-4 left-4 z-40 flex h-12 w-12 touch-none items-center justify-center rounded-full bg-accent-solid text-accent-solid-fg shadow-lg transition-colors hover:bg-accent-hover"
					>
						<Plus className="h-6 w-6" />
					</button>
				</Tooltip>
			)}
			<CreateTaskDialog selectProject projectId={active?.slug} open={open} onOpenChange={setOpen} />
		</>
	);
}
