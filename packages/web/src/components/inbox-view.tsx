import { Inbox } from 'lucide-react';
import { type Approval, useAllPendingApprovals } from '../hooks/use-approvals';
import { type NotificationItem, useAllNotifications } from '../hooks/use-notifications';
import { ApprovalCard } from './approval-card';
import { NotificationCard } from './notification-card';
import { EmptyState } from './ui/empty-state';

interface InboxViewProps {
	companyIds: string[];
	scope: 'company' | 'global';
}

type InboxItem =
	| { kind: 'approval'; created_at: string; approval: Approval }
	| { kind: 'notification'; created_at: string; notification: NotificationItem };

export function InboxView({ companyIds, scope }: InboxViewProps) {
	const { data: approvals, isLoading: approvalsLoading } = useAllPendingApprovals(companyIds);
	const { data: notifications, isLoading: notificationsLoading } = useAllNotifications(companyIds, {
		unreadOnly: true,
	});

	if (approvalsLoading || notificationsLoading) {
		return <div className="p-8 text-text-muted">Loading...</div>;
	}

	const items: InboxItem[] = [
		...(approvals ?? []).map(
			(a): InboxItem => ({ kind: 'approval', created_at: a.created_at, approval: a }),
		),
		...(notifications ?? []).map(
			(n): InboxItem => ({ kind: 'notification', created_at: n.created_at, notification: n }),
		),
	].sort((a, b) => b.created_at.localeCompare(a.created_at));

	return (
		<div>
			<h1 className="text-[22px] font-medium mb-5">Inbox</h1>

			{items.length === 0 ? (
				<EmptyState
					icon={<Inbox className="w-10 h-10" />}
					title="All clear"
					description="No pending approvals or notifications."
				/>
			) : (
				<div className="flex flex-col gap-3">
					{items.map((item) =>
						item.kind === 'approval' ? (
							<ApprovalCard
								key={`approval-${item.approval.id}`}
								approval={item.approval}
								showCompany={scope === 'global'}
							/>
						) : (
							<NotificationCard
								key={`notification-${item.notification.id}`}
								notification={item.notification}
								showCompany={scope === 'global'}
							/>
						),
					)}
				</div>
			)}
		</div>
	);
}
