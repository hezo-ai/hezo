import { ApprovalStatus } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Check, Pencil, UserPlus, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Callout } from '../ui/callout';
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
		// `role="none"` throughout: a thread renders many of these at once, and the
		// thread is what a reader follows - one live region per card is noise.
		return (
			<Callout
				tone="success"
				role="none"
				className="border border-success"
				icon={<Check className="w-4 h-4" />}
				data-testid="hire-proposal-approved"
			>
				<div>
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
			</Callout>
		);
	}

	if (status === ApprovalStatus.Denied) {
		return (
			<Callout
				tone="neutral"
				role="none"
				className="border border-border"
				icon={<X className="w-4 h-4 text-text-3" />}
				data-testid="hire-proposal-denied"
			>
				<div>
					<p className="text-sm font-medium text-text-1">
						Hire proposal for <span className="font-semibold">{title}</span> was denied
					</p>
					{note && <p className="text-xs text-text-2 mt-0.5">Note: {note}</p>}
				</div>
			</Callout>
		);
	}

	return (
		<Callout
			tone="warning"
			role="none"
			className="border border-warning"
			icon={<UserPlus className="w-4 h-4" />}
			data-testid="hire-proposal-pending"
		>
			<div className="flex flex-col gap-2">
				<div>
					<p className="text-sm font-medium text-text-1">
						Proposing to hire <span className="font-semibold">{title}</span>
					</p>
					{roleDescription && <p className="text-xs text-text-2 mt-0.5">{roleDescription}</p>}
					<p className="text-xs text-text-2 mt-1">
						Pending admin review - edit and review the full spec to approve or deny.
					</p>
				</div>
				{projectId && approvalId && (
					<div>
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
		</Callout>
	);
}
