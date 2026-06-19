import { Link } from '@tanstack/react-router';
import { ChevronRight, Inbox } from 'lucide-react';
import { useAdminMentions } from '../hooks/use-admin-mentions';
import { useApprovals } from '../hooks/use-approvals';

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
 * Persistent banner surfacing the admin's outstanding inbox backlog (pending approvals + unread
 * mentions) at the top of the task list. Clicking navigates to the Inbox where items are resolved.
 * Renders nothing when the backlog is empty — which also hides it for non-admin users, whose
 * approval/mention queries 403 and leave the counts at zero.
 */
export function AdminApprovalsBanner({ projectId }: { projectId: string }) {
	const { data: approvals } = useApprovals(projectId);
	const { data: mentions } = useAdminMentions(projectId);

	const approvalCount = approvals?.length ?? 0;
	const mentionCount = mentions?.filter((m) => m.read_at === null).length ?? 0;
	const total = approvalCount + mentionCount;

	if (total === 0) return null;

	return (
		<Link
			to="/projects/$projectId/inbox"
			params={{ projectId }}
			data-testid="admin-approvals-banner"
			className="mb-4 flex items-center gap-2 rounded-md bg-inverse/10 px-4 py-2 text-[13px] font-medium text-text-1 hover:bg-inverse/15 transition-colors"
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
