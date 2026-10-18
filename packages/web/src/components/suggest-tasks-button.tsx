import { useNavigate } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { useMe } from '../hooks/use-me';
import { useProject } from '../hooks/use-projects';
import { useStartTaskSuggestions } from '../hooks/use-tasks';
import { toast } from '../hooks/use-toast';
import { useI18n } from '../lib/i18n';

/**
 * "Suggest tasks" beside "New task": asks the CEO for task suggestions and goes
 * to the CEO's suggestions task. Superusers only, matching the route's gate, and
 * never on HQ. Icon-only below the desktop breakpoint, like "New task".
 */
export function SuggestTasksButton({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const navigate = useNavigate();
	const { data: me } = useMe();
	const { data: project } = useProject(projectId);
	const start = useStartTaskSuggestions(projectId);

	if (me?.is_superuser !== true || !project || project.is_internal) return null;

	const label = t('tasks.suggest.action');
	return (
		<button
			type="button"
			disabled={start.isPending}
			onClick={() =>
				start.mutate(undefined, {
					onSuccess: (result) =>
						navigate({
							to: '/projects/$projectId/tasks/$taskId',
							params: { projectId, taskId: result.task_identifier.toLowerCase() },
						}),
					onError: (e) => toast.error(`${t('tasks.suggest.failed')}: ${e.message}`),
				})
			}
			data-testid="task-list-suggest-tasks"
			aria-label={label}
			title={label}
			className="flex h-10 w-10 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface text-text-1 shadow-xs transition-colors hover:bg-surface-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:border-accent disabled:opacity-60 lg:w-auto lg:px-3"
		>
			<Sparkles className="w-4 h-4" />
			<span className="hidden text-[13px] font-medium whitespace-nowrap lg:inline">{label}</span>
		</button>
	);
}
