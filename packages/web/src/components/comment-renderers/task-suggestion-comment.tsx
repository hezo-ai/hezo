import {
	ApprovalStatus,
	isRepeatingCadence,
	isTaskSuggestionCadence,
	isTaskSuggestionKind,
	type RepeatingCadence,
	TaskSuggestionCadence,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Check, Lightbulb, X } from 'lucide-react';
import { useResolveApproval, useSetTaskSuggestionCadence } from '../../hooks/use-approvals';
import { Trans, useI18n } from '../../lib/i18n';
import { queryClient } from '../../lib/query-client';
import { queryKeys } from '../../lib/query-keys';
import {
	TASK_SUGGESTION_CADENCE_LABEL,
	TASK_SUGGESTION_KIND_LABEL,
	TASK_SUGGESTION_REPEATS_NOTE,
} from '../../lib/task-suggestion-labels';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
import { FilterPills } from '../ui/filter-pills';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'action'>;
	projectId?: string;
	taskId?: string;
}

const CADENCES = Object.values(TaskSuggestionCadence);

/**
 * Renders a task-suggestion `action` comment (`kind: 'task_suggestion'`). A
 * suggestion is NOT a task: approving it creates the task server-side. Only a
 * suggestion the CEO gave a cadence shows the repeat choice; the card flips to a
 * created or denied summary once resolved (`chosen_option.status`).
 */
export function TaskSuggestionComment({ comment, projectId, taskId }: Props) {
	const { t } = useI18n();
	const content = comment.content ?? {};
	const title = content.title ?? '';
	const description = content.description ?? '';
	const kind = isTaskSuggestionKind(content.suggestion_kind) ? content.suggestion_kind : null;
	const suggested: RepeatingCadence | null = isRepeatingCadence(content.suggested_cadence)
		? content.suggested_cadence
		: null;
	const cadence = isTaskSuggestionCadence(content.cadence) ? content.cadence : suggested;
	const approvalId = content.approval_id;
	const chosen = comment.chosen_option;

	const resolve = useResolveApproval();
	const setCadence = useSetTaskSuggestionCadence(projectId ?? '', taskId ?? '');
	const titleNode = <span className="font-semibold">{title}</span>;

	if (chosen?.status === ApprovalStatus.Approved) {
		const identifier = chosen.created_task_identifier;
		const blockedBy = chosen.blocked_by_identifier;
		const notes = [
			suggested && cadence ? t(TASK_SUGGESTION_REPEATS_NOTE[cadence]) : null,
			blockedBy ? t('taskSuggestion.afterPlanning', { task: blockedBy }) : null,
		].filter((n): n is string => n !== null);
		// `role="none"` throughout: a thread renders many of these at once, and the
		// thread is what a reader follows - one live region per card is noise.
		return (
			<Callout
				tone="success"
				role="none"
				className="border border-success"
				icon={<Check className="w-4 h-4" />}
				data-testid="task-suggestion-approved"
			>
				<p className="text-sm font-medium text-text-1">
					<Trans
						k="taskSuggestion.approved"
						vars={{
							task:
								identifier && projectId ? (
									<Link
										to="/projects/$projectId/tasks/$taskId"
										params={{ projectId, taskId: identifier.toLowerCase() }}
										className="font-mono text-info-soft-fg hover:underline"
									>
										{identifier}
									</Link>
								) : (
									(identifier ?? '')
								),
							title: titleNode,
						}}
					/>
				</p>
				{notes.length > 0 && (
					<p className="text-xs text-text-2 mt-0.5" data-testid="task-suggestion-approved-notes">
						{notes.join(' · ')}
					</p>
				)}
			</Callout>
		);
	}

	if (chosen?.status === ApprovalStatus.Denied) {
		return (
			<Callout
				tone="neutral"
				role="none"
				className="border border-border"
				icon={<X className="w-4 h-4 text-text-3" />}
				data-testid="task-suggestion-denied"
			>
				<p className="text-sm font-medium text-text-1">
					<Trans k="taskSuggestion.denied" vars={{ title: titleNode }} />
				</p>
			</Callout>
		);
	}

	const decide = (status: typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied) => {
		if (!approvalId) return;
		resolve.mutate(
			{ approvalId, status, projectSlug: projectId },
			{
				onSuccess: () => {
					if (projectId && taskId) {
						queryClient.invalidateQueries({
							queryKey: queryKeys.projects.taskComments(projectId, taskId),
						});
					}
				},
			},
		);
	};
	const busy = resolve.isPending || setCadence.isPending;

	return (
		<Callout
			tone="warning"
			role="none"
			className="border border-warning"
			icon={<Lightbulb className="w-4 h-4" />}
			data-testid="task-suggestion-pending"
		>
			<div className="flex flex-col gap-2">
				<div>
					<p className="text-sm font-medium text-text-1">
						<Trans k="taskSuggestion.pending" vars={{ title: titleNode }} />
					</p>
					{description && <p className="text-xs text-text-2 mt-0.5">{description}</p>}
					{kind && (
						<p className="text-xs text-text-2 mt-0.5" data-testid="task-suggestion-kind">
							{t('taskSuggestion.kindLine', { kind: t(TASK_SUGGESTION_KIND_LABEL[kind]) })}
						</p>
					)}
				</div>
				{suggested && cadence && (
					<div className="flex flex-wrap items-center gap-2" data-testid="task-suggestion-repeats">
						<span className="text-xs text-text-2">{t('taskSuggestion.repeats')}</span>
						<FilterPills
							label={t('taskSuggestion.repeats')}
							options={CADENCES.map((value) => ({
								value,
								label: t(TASK_SUGGESTION_CADENCE_LABEL[value]),
							}))}
							value={cadence}
							onChange={(next) => {
								if (!approvalId || next === cadence || resolve.isPending) return;
								setCadence.mutate({ approvalId, commentId: comment.id, cadence: next });
							}}
						/>
					</div>
				)}
				<p className="text-xs text-text-2">{t('taskSuggestion.hint')}</p>
				{projectId && approvalId && (
					<div className="flex gap-2">
						<Button
							size="sm"
							disabled={busy}
							onClick={() => decide(ApprovalStatus.Approved)}
							data-testid="task-suggestion-approve"
						>
							<Check className="w-3 h-3" /> {t('taskSuggestion.approve')}
						</Button>
						<Button
							size="sm"
							variant="secondary"
							disabled={busy}
							onClick={() => decide(ApprovalStatus.Denied)}
							data-testid="task-suggestion-deny"
						>
							<X className="w-3 h-3" /> {t('taskSuggestion.deny')}
						</Button>
					</div>
				)}
			</div>
		</Callout>
	);
}
