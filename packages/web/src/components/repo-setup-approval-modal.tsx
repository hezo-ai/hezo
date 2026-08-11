import * as Dialog from '@radix-ui/react-dialog';
import { useNavigate } from '@tanstack/react-router';
import { GitBranch, Loader2 } from 'lucide-react';
import { type Approval, useBlockedTickets } from '../hooks/use-approvals';
import { useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { DialogContent } from './ui/dialog';

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
	const { t } = useI18n();
	const projectName = approval.payload_project_name ?? t('repoSetup.thisProject');
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

	function openGitSettings() {
		if (!projectSlug) return;
		onOpenChange(false);
		navigate({
			to: '/projects/$projectId/git',
			params: { projectId: projectSlug },
		});
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="lg" data-testid="repo-setup-approval-modal">
				<Dialog.Title className="text-base font-semibold mb-1 pr-8 flex items-center gap-2">
					<GitBranch className="size-4" />
					{t('repoSetup.title', { project: projectName })}
				</Dialog.Title>
				<Dialog.Description className="text-sm text-text-2 mb-4">
					{tickets.length === 1
						? t('repoSetup.blockedOne')
						: t('repoSetup.blockedMany', { count: tickets.length })}
				</Dialog.Description>

				<div className="rounded-md border border-border bg-surface max-h-72 overflow-y-auto mb-4">
					{isLoading ? (
						<div className="flex items-center gap-2 text-sm text-text-2 px-3 py-3">
							<Loader2 className="size-4 animate-spin" /> {t('repoSetup.loadingTasks')}
						</div>
					) : tickets.length === 0 ? (
						<div className="text-sm text-text-2 px-3 py-3">{t('repoSetup.noBlockedTasks')}</div>
					) : (
						// Bound as `row`, not `t` - `t` is the translate function in this scope.
						tickets.map((row) => (
							<button
								type="button"
								key={row.comment_id}
								onClick={() => openTicket(row)}
								className="flex w-full flex-col gap-0.5 items-start px-3 py-2 text-left border-b border-border-subtle last:border-b-0 hover:bg-surface-2"
								data-testid={`blocked-ticket-${row.identifier}`}
							>
								<div className="flex items-center gap-2 w-full">
									<span className="font-mono text-xs px-1.5 py-0.5 rounded bg-surface-2 text-text-2 shrink-0">
										{row.identifier}
									</span>
									<span className="text-sm font-medium truncate">{row.title}</span>
								</div>
								<div className="flex items-center gap-2 w-full text-xs text-text-2">
									<span className="truncate">
										{row.agent_name
											? t('repoSetup.byAgent', { agent: row.agent_name })
											: t('repoSetup.byUnknownAgent')}
									</span>
									<span className="text-text-3">·</span>
									<span className="italic truncate text-text-3">"{row.snippet}"</span>
								</div>
							</button>
						))
					)}
				</div>

				<div className="flex justify-end gap-2">
					<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
						{t('common.close')}
					</Button>
					<Button
						size="sm"
						onClick={openGitSettings}
						disabled={!projectSlug}
						data-testid="repo-setup-approval-cta"
					>
						{t('repoSetup.cta')}
					</Button>
				</div>
			</DialogContent>
		</Dialog.Root>
	);
}
