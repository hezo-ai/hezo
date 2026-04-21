import { Inbox } from 'lucide-react';
import { useAllPendingApprovals } from '../hooks/use-approvals';
import { ApprovalCard } from './approval-card';
import { EmptyState } from './ui/empty-state';

interface InboxViewProps {
	companyIds: string[];
	scope: 'company' | 'global';
}

export function InboxView({ companyIds, scope }: InboxViewProps) {
	const { data: approvals, isLoading } = useAllPendingApprovals(companyIds);

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
						<ApprovalCard key={a.id} approval={a} showCompany={scope === 'global'} />
					))}
				</div>
			)}
		</div>
	);
}
