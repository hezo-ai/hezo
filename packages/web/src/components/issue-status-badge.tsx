import { formatIssueStatus, IssueStatus } from '@hezo/shared';
import { Badge } from './ui/badge';

type BadgeColor = 'neutral' | 'warning' | 'purple' | 'danger' | 'success';

const STATUS_COLORS: Record<IssueStatus, BadgeColor> = {
	[IssueStatus.Backlog]: 'neutral',
	[IssueStatus.InProgress]: 'warning',
	[IssueStatus.Review]: 'purple',
	[IssueStatus.Blocked]: 'danger',
	[IssueStatus.Done]: 'success',
	[IssueStatus.Closed]: 'neutral',
	[IssueStatus.Cancelled]: 'neutral',
};

export function IssueStatusBadge({ status }: { status: string }) {
	const color = STATUS_COLORS[status as IssueStatus] ?? 'neutral';
	return <Badge color={color}>{formatIssueStatus(status)}</Badge>;
}
