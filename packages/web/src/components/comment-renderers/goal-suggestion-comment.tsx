import { ApprovalStatus } from '@hezo/shared';
import { Check, Target, X } from 'lucide-react';
import { useResolveGoalSuggestion } from '../../hooks/use-goals';
import { Button } from '../ui/button';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'action'>;
	projectId?: string;
}

/**
 * Renders a goal-suggestion `action` comment (`kind: 'goal_suggestion'`). A goal
 * suggestion is NOT a goal — approving it creates the real goal server-side. The
 * pending card offers inline Approve/Deny (both resolve the linked approval); it
 * flips to a created/denied summary once resolved (`chosen_option.status`).
 */
export function GoalSuggestionComment({ comment, projectId }: Props) {
	const content = comment.content ?? {};
	const title = content.title ?? 'a goal';
	const measurement = content.measurement ?? '';
	const frequency = content.check_frequency ?? 'daily';
	const targetDate = content.target_date as string | null | undefined;
	const approvalId = content.approval_id as string | undefined;
	const status = comment.chosen_option?.status;

	const resolve = useResolveGoalSuggestion(projectId ?? '');

	if (status === ApprovalStatus.Approved) {
		return (
			<div
				className="flex items-start gap-2 p-2.5 rounded-lg border border-success bg-success-soft"
				data-testid="goal-suggestion-approved"
			>
				<Check className="w-4 h-4 text-success-soft-fg shrink-0 mt-0.5" />
				<p className="text-sm font-medium text-text-1">
					Goal created: <span className="font-semibold">{title}</span>
				</p>
			</div>
		);
	}

	if (status === ApprovalStatus.Denied) {
		return (
			<div
				className="flex items-start gap-2 p-2.5 rounded-lg border border-border bg-surface-2"
				data-testid="goal-suggestion-denied"
			>
				<X className="w-4 h-4 text-text-3 shrink-0 mt-0.5" />
				<p className="text-sm font-medium text-text-1">
					Goal suggestion <span className="font-semibold">{title}</span> was denied
				</p>
			</div>
		);
	}

	return (
		<div
			className="flex flex-col gap-2 p-2.5 rounded-lg border border-warning bg-warning-soft"
			data-testid="goal-suggestion-pending"
		>
			<div className="flex items-start gap-2">
				<Target className="w-4 h-4 text-warning-soft-fg shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text-1">
						Suggested goal: <span className="font-semibold">{title}</span>
					</p>
					{measurement && <p className="text-xs text-text-2 mt-0.5">Measure: {measurement}</p>}
					<p className="text-xs text-text-2 mt-0.5">
						Checked {frequency}
						{targetDate ? ` · by ${String(targetDate).slice(0, 10)}` : ''}
					</p>
					<p className="text-xs text-text-2 mt-1">
						Approve to create this goal, or deny to dismiss.
					</p>
				</div>
			</div>
			{projectId && approvalId && (
				<div className="flex gap-2 pl-6">
					<Button
						size="sm"
						disabled={resolve.isPending}
						onClick={() => resolve.mutate({ approvalId, status: ApprovalStatus.Approved })}
						data-testid="goal-suggestion-approve"
					>
						<Check className="w-3 h-3" /> Approve
					</Button>
					<Button
						size="sm"
						variant="secondary"
						disabled={resolve.isPending}
						onClick={() => resolve.mutate({ approvalId, status: ApprovalStatus.Denied })}
						data-testid="goal-suggestion-deny"
					>
						<X className="w-3 h-3" /> Deny
					</Button>
				</div>
			)}
		</div>
	);
}
