import {
	CommentContentType,
	PROJECT_INTAKE_LABEL,
	PROJECT_INTAKE_SKIP_SIGNAL_TEXT,
} from '@hezo/shared';
import { FastForward, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import type { Comment } from '../../hooks/use-comments';
import { useSkipProjectIntakeQuestions } from '../../hooks/use-project-intake';
import type { Task } from '../../hooks/use-tasks';
import { Button } from '../ui/button';

interface ProjectIntakeBannerProps {
	task: Task;
	teamId: string;
	taskId: string;
	comments: Comment[] | undefined;
}

/**
 * Skip-questions affordance for the project intake flow. Renders only when the
 * task carries the project-intake label AND no skip signal has been recorded
 * yet. Lives in the comment composer toolbar so the operator can bail from
 * intake at any point without leaving the task.
 */
export function ProjectIntakeBanner({ task, teamId, taskId, comments }: ProjectIntakeBannerProps) {
	const skipProjectIntake = useSkipProjectIntakeQuestions(teamId, taskId);
	const isProjectIntake = useMemo(
		() => (task.labels ?? []).includes(PROJECT_INTAKE_LABEL),
		[task.labels],
	);
	const projectIntakeSkipped = useMemo(
		() =>
			isProjectIntake &&
			(comments ?? []).some(
				(c) =>
					c.content_type === CommentContentType.System &&
					c.author_member_id === null &&
					(() => {
						const content = c.content as unknown;
						if (typeof content === 'string') return content === PROJECT_INTAKE_SKIP_SIGNAL_TEXT;
						if (typeof content === 'object' && content !== null && 'text' in content) {
							return (content as { text?: unknown }).text === PROJECT_INTAKE_SKIP_SIGNAL_TEXT;
						}
						return false;
					})(),
			),
		[comments, isProjectIntake],
	);

	if (!isProjectIntake || projectIntakeSkipped) return null;

	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			onClick={() => skipProjectIntake.mutate()}
			disabled={skipProjectIntake.isPending}
			data-testid="project-intake-skip"
			className="mr-auto"
		>
			{skipProjectIntake.isPending ? (
				<Loader2 className="w-3 h-3 animate-spin" />
			) : (
				<FastForward className="w-3 h-3" />
			)}
			Skip questions — propose now
		</Button>
	);
}
