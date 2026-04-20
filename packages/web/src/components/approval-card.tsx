import { ApprovalStatus } from '@hezo/shared';
import { Check, Loader2, X } from 'lucide-react';
import type { Approval } from '../hooks/use-approvals';
import { useResolveApproval } from '../hooks/use-approvals';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const typeColors: Record<string, string> = {
	kb_update: 'blue',
	strategy: 'purple',
	oauth_request: 'yellow',
	secret_access: 'red',
	hire: 'green',
	plan_review: 'blue',
	deploy_production: 'red',
};

interface ApprovalCardProps {
	approval: Approval;
	showCompany?: boolean;
}

export function ApprovalCard({ approval, showCompany = false }: ApprovalCardProps) {
	const resolveApproval = useResolveApproval();

	return (
		<div className="p-4 border border-border rounded-radius-md">
			<div className="flex items-center gap-2 mb-1.5 flex-wrap">
				<Badge color={typeColors[approval.type] as 'gray'}>{approval.type.replace('_', ' ')}</Badge>
				{showCompany && approval.company_name && (
					<span className="text-xs text-text-muted">{approval.company_name}</span>
				)}
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
