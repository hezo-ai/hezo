import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { GitBranch, Loader2 } from 'lucide-react';
import { type Approval, useBlockedTickets } from '../hooks/use-approvals';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';

interface RepoSetupApprovalModalProps {
	approval: Approval;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function RepoSetupApprovalModal({
	approval,
	open,
	onOpenChange,
}: RepoSetupApprovalModalProps) {
	const navigate = useNavigate();
	const projectName = approval.payload_project_name ?? 'this project';
	const projectSlug = approval.payload_project_slug;
	// blocked-tickets is team-scoped server-side; address it via the project slug
	// (the public handle) rather than the now-internal team id.
	const { data: tickets = [], isLoading } = useBlockedTickets(projectSlug, approval.id, open);

	function openTicket(ticket: {
		project_slug: string;
		identifier: string;
		comment_public_id: string;
	}) {
		onOpenChange(false);
		navigate({
			to: '/projects/$projectId/tasks/$taskId',
			params: {
				projectId: ticket.project_slug,
				taskId: ticket.identifier.toLowerCase(),
			},
			hash: `comment-${ticket.comment_public_id}`,
		});
	}

	function openSettings() {
		if (!projectSlug) return;
		onOpenChange(false);
		navigate({
			to: '/projects/$projectId/settings',
			params: { projectId: projectSlug },
		});
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content
					className={dialogContentClassName.lg}
					data-testid="repo-setup-approval-modal"
				>
					<Dialog.Title className="text-base font-semibold mb-1 flex items-center gap-2">
						<GitBranch className="size-4" />
						Set up GitHub for {projectName}
					</Dialog.Title>
					<Dialog.Description className="text-sm text-text-muted mb-4">
						{tickets.length === 1
							? '1 ticket is paused, waiting for a GitHub repository to be configured for this project.'
							: `${tickets.length} tickets are paused, waiting for a GitHub repository to be configured for this project.`}
					</Dialog.Description>

					<div className="rounded-radius-md border border-border bg-bg max-h-72 overflow-y-auto mb-4">
						{isLoading ? (
							<div className="flex items-center gap-2 text-sm text-text-muted px-3 py-3">
								<Loader2 className="size-4 animate-spin" /> Loading tickets…
							</div>
						) : tickets.length === 0 ? (
							<div className="text-sm text-text-muted px-3 py-3">No blocked tickets.</div>
						) : (
							tickets.map((t) => (
								<button
									type="button"
									key={t.comment_id}
									onClick={() => openTicket(t)}
									className="flex w-full flex-col gap-0.5 items-start px-3 py-2 text-left border-b border-border-subtle last:border-b-0 hover:bg-bg-subtle"
									data-testid={`blocked-ticket-${t.identifier}`}
								>
									<div className="flex items-center gap-2 w-full">
										<span className="font-mono text-xs px-1.5 py-0.5 rounded bg-bg-subtle text-text-muted shrink-0">
											{t.identifier}
										</span>
										<span className="text-sm font-medium truncate">{t.title}</span>
									</div>
									<div className="flex items-center gap-2 w-full text-xs text-text-muted">
										<span className="truncate">by {t.agent_name ?? 'agent'}</span>
										<span className="text-text-subtle">·</span>
										<span className="italic truncate text-text-subtle">"{t.snippet}"</span>
									</div>
								</button>
							))
						)}
					</div>

					<div className="flex justify-end gap-2">
						<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
							Close
						</Button>
						<Button
							size="sm"
							onClick={openSettings}
							disabled={!projectSlug}
							data-testid="repo-setup-approval-cta"
						>
							Set up GitHub
						</Button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
