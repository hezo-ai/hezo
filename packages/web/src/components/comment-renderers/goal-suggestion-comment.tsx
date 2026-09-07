import { ApprovalStatus } from '@hezo/shared';
import { Check, Target, X } from 'lucide-react';
import { GOAL_EXPLAINER_TOOLTIP, useResolveGoalSuggestion } from '../../hooks/use-goals';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { InfoTooltip } from '../ui/info-tooltip';
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
		// `role="none"` throughout: a thread renders many of these at once, and the
		// thread is what a reader follows - one live region per card is noise.
		return (
			<Callout
				tone="success"
				role="none"
				className="border border-success"
				icon={<Check className="w-4 h-4" />}
				data-testid="goal-suggestion-approved"
			>
				<p className="text-sm font-medium text-text-1">
					Goal created: <span className="font-semibold">{title}</span>
				</p>
			</Callout>
		);
	}

	if (status === ApprovalStatus.Denied) {
		return (
			<Callout
				tone="neutral"
				role="none"
				className="border border-border"
				icon={<X className="w-4 h-4 text-text-3" />}
				data-testid="goal-suggestion-denied"
			>
				<p className="text-sm font-medium text-text-1">
					Goal suggestion <span className="font-semibold">{title}</span> was denied
				</p>
			</Callout>
		);
	}

	return (
		<Callout
			tone="warning"
			role="none"
			className="border border-warning"
			icon={<Target className="w-4 h-4" />}
			data-testid="goal-suggestion-pending"
		>
			<div className="flex flex-col gap-2">
				<div>
					<div className="flex items-start gap-1.5">
						<p className="text-sm font-medium text-text-1">
							Suggested goal: <span className="font-semibold">{title}</span>
						</p>
						<InfoTooltip
							label="What is a goal?"
							content={GOAL_EXPLAINER_TOOLTIP}
							data-testid="goal-suggestion-info"
							className="mt-0.5"
						/>
					</div>
					{measurement && <p className="text-xs text-text-2 mt-0.5">Measure: {measurement}</p>}
					<p className="text-xs text-text-2 mt-0.5">
						Checked {frequency}
						{targetDate ? ` · by ${String(targetDate).slice(0, 10)}` : ''}
					</p>
					<p className="text-xs text-text-2 mt-1">
						Approve to create this goal, or deny to dismiss.
					</p>
				</div>
				{projectId && approvalId && (
					<div className="flex gap-2">
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
		</Callout>
	);
}
