import { ApprovalStatus } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Check, Inbox, Loader2, X } from 'lucide-react';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { EmptyState } from '../../../../components/ui/empty-state';
import type { Approval } from '../../../../hooks/use-approvals';
import { useApprovals, useResolveApproval } from '../../../../hooks/use-approvals';

const typeColors: Record<string, string> = {
	kb_update: 'blue',
	strategy: 'purple',
	oauth_request: 'yellow',
	secret_access: 'red',
	hire: 'green',
	plan_review: 'blue',
	deploy_production: 'red',
};

function ApprovalCard({ approval }: { approval: Approval }) {
	const resolveApproval = useResolveApproval();

	return (
		<div className="p-4 border border-border rounded-radius-md">
			<div className="flex items-center gap-2 mb-1.5">
				<Badge color={typeColors[approval.type] as 'gray'}>{approval.type.replace('_', ' ')}</Badge>
			</div>
			{approval.requested_by_name && (
				<p className="text-xs text-text-muted mb-1">From: {approval.requested_by_name}</p>
			)}
			<p className="text-sm text-text-subtle mb-3 break-words">
				{JSON.stringify(approval.payload).substring(0, 300)}
			</p>
			<div className="flex gap-2">
				<Button
					size="sm"
					variant="secondary"
					disabled={resolveApproval.isPending}
					onClick={() =>
						resolveApproval.mutate({
							approvalId: approval.id,
							status: ApprovalStatus.Approved,
						})
					}
				>
					{resolveApproval.isPending ? (
						<Loader2 className="w-3 h-3 animate-spin" />
					) : (
						<Check className="w-3 h-3" />
					)}
					Approve
				</Button>
				<Button
					size="sm"
					variant="ghost"
					className="text-accent-red"
					disabled={resolveApproval.isPending}
					onClick={() =>
						resolveApproval.mutate({
							approvalId: approval.id,
							status: ApprovalStatus.Denied,
						})
					}
				>
					<X className="w-3 h-3" /> Deny
				</Button>
			</div>
		</div>
	);
}

function InboxPage() {
	const { companyId } = Route.useParams();
	const { data: approvals, isLoading } = useApprovals(companyId);

	if (isLoading) {
		return <div className="p-8 text-text-muted">Loading...</div>;
	}

	return (
		<div>
			<h1 className="text-[22px] font-medium mb-5">Inbox</h1>

			{!approvals?.length ? (
				<EmptyState
					icon={<Inbox className="w-10 h-10" />}
					title="All clear"
					description="No pending approvals."
				/>
			) : (
				<div className="flex flex-col gap-3">
					{approvals.map((a) => (
						<ApprovalCard key={a.id} approval={a} />
					))}
				</div>
			)}
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/inbox/')({
	component: InboxPage,
});
