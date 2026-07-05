import { ApprovalStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Check, Pencil, UserPlus, X } from 'lucide-react';
import { Button } from '../ui/button';
import type { CommentDataOf } from './comment-data';

interface Props {
	comment: CommentDataOf<'action'>;
	projectId?: string;
}

/**
 * Renders a hire-proposal `action` comment (`kind: 'hire_proposal'`). Mirrors the
 * admin inbox card: the only action is "Edit & review" (which opens the hire page
 * where approve/deny live) — never inline approve/deny. Flips to a hired/denied
 * summary once the linked approval resolves (`chosen_option.status`).
 */
export function HireProposalComment({ comment, projectId }: Props) {
	const content = comment.content ?? {};
	const title = content.title ?? 'a new agent';
	const roleDescription = content.role_description ?? '';
	const approvalId = content.approval_id;
	const status = comment.chosen_option?.status;
	const agentSlug = comment.chosen_option?.member_agent_slug;
	const note = comment.chosen_option?.resolution_note;

	if (status === ApprovalStatus.Approved) {
		return (
			<div
				className="flex items-start gap-2 p-2.5 rounded-lg border border-success bg-success-soft"
				data-testid="hire-proposal-approved"
			>
				<Check className="w-4 h-4 text-success-soft-fg shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text-1">
						Hired <span className="font-semibold">{title}</span>
					</p>
					{agentSlug && projectId && (
						<Link
							to="/projects/$projectId/agents/$agentId"
							params={{ projectId, agentId: agentSlug }}
							className="text-xs text-accent hover:underline"
						>
							View agent
						</Link>
					)}
				</div>
			</div>
		);
	}

	if (status === ApprovalStatus.Denied) {
		return (
			<div
				className="flex items-start gap-2 p-2.5 rounded-lg border border-border bg-surface-2"
				data-testid="hire-proposal-denied"
			>
				<X className="w-4 h-4 text-text-3 shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text-1">
						Hire proposal for <span className="font-semibold">{title}</span> was denied
					</p>
					{note && <p className="text-xs text-text-2 mt-0.5">Note: {note}</p>}
				</div>
			</div>
		);
	}

	return (
		<div
			className="flex flex-col gap-2 p-2.5 rounded-lg border border-warning bg-warning-soft"
			data-testid="hire-proposal-pending"
		>
			<div className="flex items-start gap-2">
				<UserPlus className="w-4 h-4 text-warning-soft-fg shrink-0 mt-0.5" />
				<div className="flex-1">
					<p className="text-sm font-medium text-text-1">
						Proposing to hire <span className="font-semibold">{title}</span>
					</p>
					{roleDescription && <p className="text-xs text-text-2 mt-0.5">{roleDescription}</p>}
					<p className="text-xs text-text-2 mt-1">
						Pending admin review — edit and review the full spec to approve or deny.
					</p>
				</div>
			</div>
			{projectId && approvalId && (
				<div className="pl-6">
					<Link
						to="/projects/$projectId/agents/hire"
						params={{ projectId }}
						search={{ approvalId }}
					>
						<Button size="sm" variant="secondary" data-testid="hire-proposal-edit">
							<Pencil className="w-3 h-3" /> Edit & review
						</Button>
					</Link>
				</div>
			)}
		</div>
	);
}
