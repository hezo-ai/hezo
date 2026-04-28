import { NotificationKind } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { type NotificationItem, useMarkNotificationRead } from '../hooks/use-notifications';
import { Badge } from './ui/badge';

interface NotificationCardProps {
	notification: NotificationItem;
	showCompany?: boolean;
}

const cardClass =
	'block p-4 border border-border rounded-radius-md hover:bg-bg-subtle transition-colors';

function NotificationLabel({ kind }: { kind: string }) {
	if (kind === NotificationKind.BoardApprovalRequested) {
		return <Badge color="purple">board approval</Badge>;
	}
	return <Badge color="gray">{kind.replace(/_/g, ' ')}</Badge>;
}

function buildIssueLink(notification: NotificationItem) {
	const commentId = (notification.payload.comment_id as string) ?? null;
	const hash = commentId ? `comment-${commentId}` : undefined;
	const issueIdentifier = notification.issue_identifier?.toLowerCase();
	if (!issueIdentifier) return null;

	if (notification.project_slug) {
		return {
			to: '/companies/$companyId/projects/$projectId/issues/$issueId' as const,
			params: {
				companyId: notification.company_slug,
				projectId: notification.project_slug,
				issueId: issueIdentifier,
			},
			hash,
		};
	}
	return {
		to: '/companies/$companyId/issues/$issueId' as const,
		params: { companyId: notification.company_slug, issueId: issueIdentifier },
		hash,
	};
}

export function NotificationCard({ notification, showCompany = false }: NotificationCardProps) {
	const markRead = useMarkNotificationRead();
	const dest = buildIssueLink(notification);
	const summary = (notification.payload.summary as string) ?? '';
	const isUnread = notification.read_at === null;

	const onActivate = () => {
		if (isUnread) {
			markRead.mutate({ companyId: notification.company_slug, id: notification.id });
		}
	};

	const body = (
		<>
			<div className="flex items-center gap-2 mb-1.5 flex-wrap">
				<NotificationLabel kind={notification.kind} />
				{isUnread && (
					<span role="status" className="w-2 h-2 rounded-full bg-accent-blue" aria-label="Unread" />
				)}
				{showCompany && notification.company_name && (
					<span className="text-xs text-text-muted">{notification.company_name}</span>
				)}
			</div>
			<p className="text-xs text-text-muted mb-1">
				{notification.requester_name ?? 'Agent'}
				{notification.issue_identifier ? ` on ${notification.issue_identifier}` : ''}
			</p>
			<div className={`text-sm break-words ${isUnread ? 'text-text-default' : 'text-text-muted'}`}>
				{summary || 'Board approval requested'}
			</div>
		</>
	);

	if (dest) {
		return (
			<Link
				to={dest.to as never}
				params={dest.params as never}
				{...(dest.hash ? { hash: dest.hash } : {})}
				className={cardClass}
				onClick={onActivate}
				data-testid="notification-card"
			>
				{body}
			</Link>
		);
	}

	return (
		<div
			className={cardClass.replace('hover:bg-bg-subtle transition-colors', '')}
			data-testid="notification-card"
		>
			{body}
		</div>
	);
}
