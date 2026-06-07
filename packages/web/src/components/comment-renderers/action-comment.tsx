import { Link } from '@tanstack/react-router';
import { Check, GitBranch } from 'lucide-react';
import { Button } from '../ui/button';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'action'>;
	projectId?: string;
	taskId?: string;
}

export function ActionComment({ comment, projectId }: Props) {
	const kind = comment.content?.kind ?? '';
	const resolved = comment.chosen_option?.status === 'complete';

	if (kind !== 'setup_repo') {
		return <p className="text-xs text-text-subtle italic">Unknown action: {kind}</p>;
	}

	if (resolved) {
		const result = comment.chosen_option?.result;
		return (
			<div
				className="flex items-center gap-2 text-sm text-accent-green-text"
				data-testid="action-complete"
			>
				<Check className="w-4 h-4" />
				<span>Repository set: {result?.repo_identifier ?? '(unknown)'}</span>
			</div>
		);
	}

	if (!projectId || !projectId) {
		return <p className="text-xs text-text-subtle italic">Repo setup unavailable in this view.</p>;
	}

	return (
		<div className="flex flex-col gap-2" data-testid="action-setup-repo">
			<div className="flex items-center gap-2 text-sm">
				<GitBranch className="w-4 h-4 text-accent-blue-text" />
				<span>
					This project has no designated repository yet. Add a repo URL in project settings, then
					this ticket will resume.
				</span>
			</div>
			<div>
				<Link to="/projects/$projectId/settings" params={{ projectId }}>
					<Button size="sm">Open project settings</Button>
				</Link>
			</div>
		</div>
	);
}
