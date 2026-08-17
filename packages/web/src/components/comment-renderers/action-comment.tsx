import { ActionCommentKind } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Check, GitBranch } from 'lucide-react';
import { Button } from '../ui/button';
import type { CommentDataOf } from './comment-data';
import { GoalSuggestionComment } from './goal-suggestion-comment';
import { HireProposalComment } from './hire-proposal-comment';

interface Props {
	comment: CommentDataOf<'action'>;
	projectId?: string;
	taskId?: string;
}

export function ActionComment({ comment, projectId }: Props) {
	const kind = comment.content?.kind ?? '';

	if (kind === ActionCommentKind.HireProposal) {
		return <HireProposalComment comment={comment} projectId={projectId} />;
	}

	if (kind === ActionCommentKind.GoalSuggestion) {
		return <GoalSuggestionComment comment={comment} projectId={projectId} />;
	}

	if (kind !== ActionCommentKind.SetupRepo) {
		// An action kind this bundle doesn't recognize — almost always version skew:
		// the server was updated to emit a new kind while this tab still runs older
		// JS (the shell surfaces a "refresh" prompt for exactly this). Degrade to a
		// neutral, actionable message rather than a raw "Unknown action: <kind>"
		// string that reads as broken; keep the kind in `title` for debugging.
		return (
			<p
				className="text-xs text-text-3 italic"
				data-testid="action-unknown"
				title={kind ? `Unrecognized action: ${kind}` : undefined}
			>
				This item needs a newer version to display - refresh the page.
			</p>
		);
	}

	const resolved = comment.chosen_option?.status === 'complete';

	if (resolved) {
		const result = comment.chosen_option?.result;
		return (
			<div
				className="flex items-center gap-2 text-sm text-success-soft-fg"
				data-testid="action-complete"
			>
				<Check className="w-4 h-4" />
				<span>Repository set: {result?.repo_identifier ?? '(unknown)'}</span>
			</div>
		);
	}

	if (!projectId || !projectId) {
		return <p className="text-xs text-text-3 italic">Repo setup unavailable in this view.</p>;
	}

	return (
		<div className="flex flex-col gap-2" data-testid="action-setup-repo">
			<div className="flex items-center gap-2 text-sm">
				<GitBranch className="w-4 h-4 text-info-soft-fg" />
				<span>
					This project has no designated repository yet. Add a repo on the Git settings page, then
					this task will resume.
				</span>
			</div>
			<div className="pl-6">
				<Link to="/projects/$projectId/git" params={{ projectId }}>
					<Button size="sm">Open Git settings</Button>
				</Link>
			</div>
		</div>
	);
}
