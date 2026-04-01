import * as Dialog from '@radix-ui/react-dialog';
import { Check, Loader2, X } from 'lucide-react';
import type { Approval } from '../hooks/use-approvals';
import { useResolveApproval } from '../hooks/use-approvals';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface BoardInboxDrawerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	approvals: Approval[];
}

const typeColors: Record<string, string> = {
	kb_update: 'blue',
	strategy: 'purple',
	oauth_request: 'yellow',
	secret_access: 'red',
	hire: 'green',
	plan_review: 'blue',
	deploy_production: 'red',
};

export function BoardInboxDrawer({ open, onOpenChange, approvals }: BoardInboxDrawerProps) {
	const resolveApproval = useResolveApproval();

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/40" />
				<Dialog.Content className="fixed top-0 right-0 h-full w-full max-w-md border-l border-border bg-bg-subtle shadow-2xl overflow-y-auto">
					<div className="flex items-center justify-between p-4 border-b border-border">
						<Dialog.Title className="text-sm font-semibold">Board Inbox</Dialog.Title>
						<Dialog.Close asChild>
							<button type="button" className="text-text-muted hover:text-text">
								<X className="w-4 h-4" />
							</button>
						</Dialog.Close>
					</div>

					{approvals.length === 0 ? (
						<div className="p-8 text-center text-sm text-text-muted">No pending approvals</div>
					) : (
						<div className="flex flex-col">
							{approvals.map((a) => (
								<div key={a.id} className="p-4 border-b border-border-subtle">
									<div className="flex items-center gap-2 mb-1.5">
										<Badge color={typeColors[a.type] as 'gray'}>{a.type.replace('_', ' ')}</Badge>
										<span className="text-xs text-text-subtle">{a.company_name}</span>
									</div>
									{a.requested_by_name && (
										<p className="text-xs text-text-muted mb-1">From: {a.requested_by_name}</p>
									)}
									<p className="text-xs text-text-subtle mb-3 break-words">
										{JSON.stringify(a.payload).substring(0, 200)}
									</p>
									<div className="flex gap-2">
										<Button
											size="sm"
											variant="secondary"
											disabled={resolveApproval.isPending}
											onClick={() =>
												resolveApproval.mutate({ approvalId: a.id, status: 'approved' })
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
											className="text-danger"
											disabled={resolveApproval.isPending}
											onClick={() => resolveApproval.mutate({ approvalId: a.id, status: 'denied' })}
										>
											<X className="w-3 h-3" /> Deny
										</Button>
									</div>
								</div>
							))}
						</div>
					)}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
