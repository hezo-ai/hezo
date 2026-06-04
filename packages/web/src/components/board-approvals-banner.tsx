import { Link } from '@tanstack/react-router';
import { ChevronRight, Inbox } from 'lucide-react';
import { useApprovals } from '../hooks/use-approvals';
import { useBoardMentions } from '../hooks/use-board-mentions';

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function buildMessage(approvalCount: number, mentionCount: number): string {
	const parts: string[] = [];
	if (approvalCount > 0) parts.push(pluralize(approvalCount, 'approval'));
	if (mentionCount > 0) parts.push(pluralize(mentionCount, 'mention'));
	return `${parts.join(' and ')} ${parts.length > 1 ? 'need' : approvalCount + mentionCount === 1 ? 'needs' : 'need'} your review`;
}

/**
 * Persistent banner surfacing the board's outstanding inbox backlog (pending approvals + unread
 * mentions) at the top of the task list. Clicking navigates to the Inbox where items are resolved.
 * Renders nothing when the backlog is empty — which also hides it for non-board users, whose
 * approval/mention queries 403 and leave the counts at zero.
 */
export function BoardApprovalsBanner({ teamId }: { teamId: string }) {
	const { data: approvals } = useApprovals(teamId);
	const { data: mentions } = useBoardMentions(teamId);

	const approvalCount = approvals?.length ?? 0;
	const mentionCount = mentions?.filter((m) => m.read_at === null).length ?? 0;
	const total = approvalCount + mentionCount;

	if (total === 0) return null;

	return (
		<Link
			to="/teams/$teamId/inbox"
			params={{ teamId }}
			data-testid="board-approvals-banner"
			className="mb-4 flex items-center gap-2 rounded-md bg-primary/10 px-4 py-2 text-[13px] font-medium text-primary hover:bg-primary/15 transition-colors"
		>
			<Inbox className="w-3.5 h-3.5 shrink-0" />
			<span className="min-w-0 truncate">{buildMessage(approvalCount, mentionCount)}</span>
			<span className="ml-auto flex items-center gap-1 shrink-0">
				<span className="hidden sm:inline">View inbox</span>
				<ChevronRight className="w-3.5 h-3.5" />
			</span>
		</Link>
	);
}
