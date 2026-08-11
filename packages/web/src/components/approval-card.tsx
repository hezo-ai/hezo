import { ApprovalStatus, ApprovalType, OAuthRequestReason } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { useState } from 'react';
import type { Approval } from '../hooks/use-approvals';
import { useResolveApproval } from '../hooks/use-approvals';
import { agentAvatarUrl } from '../lib/agent-avatar';
import { approvalTypeColor } from '../lib/status-meta';
import { RepoSetupApprovalModal } from './repo-setup-approval-modal';
import { Avatar, getInitials } from './ui/avatar';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const linkClass = 'font-medium text-accent hover:underline';

function EntityLink({
	to,
	params,
	children,
}: {
	to: string;
	params: Record<string, string>;
	children: React.ReactNode;
}) {
	return (
		// biome-ignore lint: dynamic route params
		<Link to={to as never} params={params as never} className={linkClass}>
			{children}
		</Link>
	);
}

function ApprovalMessage({ approval }: { approval: Approval }) {
	const p = approval.payload;
	const teamSlug = approval.team_slug;

	switch (approval.type) {
		case ApprovalType.DesignatedRepoRequest: {
			const platform = (p.platform as string) ?? 'GitHub';
			const reason = p.reason as string | undefined;
			const projectName = approval.payload_project_name;
			const action =
				reason === 'designated_repo'
					? 'set up the designated repo for'
					: reason === 'repo_add'
						? 'add a repo to'
						: 'access';
			return (
				<span>
					Requesting {platform} OAuth to {action}
					{projectName && (
						<>
							{' '}
							project <span className="font-medium">{projectName}</span>
						</>
					)}
				</span>
			);
		}
		case ApprovalType.Hire: {
			const title = (p.title as string) ?? 'a new agent';
			const taskId = approval.payload_task_identifier;
			const taskProjectSlug = approval.payload_project_slug;
			return (
				<span>
					Proposing to hire <span className="font-medium">{title}</span>
					{taskId && (
						<>
							{' '}
							(
							{taskProjectSlug ? (
								<EntityLink
									to="/projects/$projectId/tasks/$taskId"
									params={{
										projectId: taskProjectSlug,
										taskId: taskId.toLowerCase(),
									}}
								>
									{taskId}
								</EntityLink>
							) : (
								<EntityLink
									to="/projects/$projectId/tasks/$taskId"
									params={{ projectId: teamSlug, taskId: taskId.toLowerCase() }}
								>
									{taskId}
								</EntityLink>
							)}
							)
						</>
					)}
				</span>
			);
		}
		case ApprovalType.SkillProposal: {
			const skillName = (p.skill_name as string) ?? (p.skill_slug as string) ?? 'a skill';
			return (
				<>
					<span>
						Proposing new skill: "<span className="font-medium">{skillName}</span>"
					</span>
					{p.reason && <span className="block text-xs text-text-2 mt-1">{p.reason as string}</span>}
				</>
			);
		}
		case ApprovalType.PlanReview: {
			return (
				<>
					<span>Requesting plan review</span>
					{p.reason && <span className="block text-xs text-text-2 mt-1">{p.reason as string}</span>}
				</>
			);
		}
		case ApprovalType.Strategy: {
			const plan = p.plan as string | undefined;
			return (
				<>
					<span>Proposing strategy</span>
					{plan && <span className="block text-xs text-text-2 mt-1">{plan}</span>}
				</>
			);
		}
		case ApprovalType.DeployProduction: {
			const target = (p.target as string) ?? (p.environment as string) ?? 'production';
			return (
				<>
					<span>
						Requesting deploy to <span className="font-medium">{target}</span>
					</span>
					{p.reason && <span className="block text-xs text-text-2 mt-1">{p.reason as string}</span>}
				</>
			);
		}
		case ApprovalType.GoalSuggestion: {
			const title = (p.title as string) ?? 'a goal';
			return (
				<>
					<span>
						Suggesting goal <span className="font-medium">{title}</span> — approving creates it
					</span>
					{p.measurement && (
						<span className="block text-xs text-text-2 mt-1">
							Measure: {p.measurement as string}
						</span>
					)}
				</>
			);
		}
		default:
			return <span>{approval.type.replace(/_/g, ' ')}</span>;
	}
}

interface ApprovalCardProps {
	approval: Approval;
	showTeam?: boolean;
}

const baseCardClass = 'block p-4 border border-border rounded-md';
const linkCardClass = `${baseCardClass} hover:bg-surface-2 transition-colors`;

function CardBody({
	approval,
	showTeam,
	unread,
}: {
	approval: Approval;
	showTeam: boolean;
	unread: boolean;
}) {
	const resolved = approval.status !== ApprovalStatus.Pending;
	return (
		<>
			<div className="flex items-center gap-2 mb-1.5 flex-wrap">
				{unread && (
					<span
						role="img"
						aria-label="Unread"
						className="w-2 h-2 rounded-full bg-inverse shrink-0"
					/>
				)}
				<Badge variant="dot" color={approvalTypeColor(approval.type)}>
					{approval.type.replace('_', ' ')}
				</Badge>
				{resolved && (
					<Badge color={approval.status === ApprovalStatus.Approved ? 'green' : 'red'}>
						{approval.status}
					</Badge>
				)}
				{showTeam && approval.team_name && (
					<span className="text-xs text-text-2">{approval.team_name}</span>
				)}
			</div>
			{approval.requested_by_name && (
				// A div, not a p: Avatar renders a div and cannot legally nest in a p.
				<div className="text-xs text-text-2 mb-1">
					<Avatar
						size="sm"
						initials={getInitials(approval.requested_by_name)}
						imageUrl={
							approval.requested_by_icon_url ??
							agentAvatarUrl({
								slug: approval.requested_by_slug,
								avatar_spec: approval.requested_by_avatar_spec,
							})
						}
						className="mr-1.5 align-middle"
					/>
					<span className="align-middle">From: {approval.requested_by_name}</span>
				</div>
			)}
			<div className="text-sm text-text-3 break-words">
				<ApprovalMessage approval={approval} />
			</div>
			{resolved && approval.resolution_note && (
				<p className="text-xs text-text-2 mt-2">Note: {approval.resolution_note}</p>
			)}
		</>
	);
}

function resolveOauthDestination(approval: Approval) {
	const reason = approval.payload.reason as string | undefined;
	const teamSlug = approval.team_slug;

	if (reason === OAuthRequestReason.RepoAdd && approval.payload_project_slug) {
		return {
			to: '/projects/$projectId/settings' as const,
			params: { projectId: approval.payload_project_slug },
		};
	}
	return {
		to: '/projects/$projectId/team-settings/general' as const,
		params: { projectId: teamSlug },
	};
}

export function ApprovalCard({ approval, showTeam = false }: ApprovalCardProps) {
	const resolveApproval = useResolveApproval();
	const [modalOpen, setModalOpen] = useState(false);
	const unread = approval.status === ApprovalStatus.Pending;
	const highlight = unread ? ' border-l-2 border-l-accent bg-surface-2' : '';

	// Resolved approvals are inbox history: read-only, no actions or navigation.
	if (!unread) {
		return (
			<div className={baseCardClass} data-testid="approval-card" data-unread={false}>
				<CardBody approval={approval} showTeam={showTeam} unread={false} />
			</div>
		);
	}

	if (approval.type === ApprovalType.DesignatedRepoRequest) {
		const reason = approval.payload.reason as string | undefined;

		if (reason === OAuthRequestReason.DesignatedRepo) {
			return (
				<>
					<button
						type="button"
						className={`${linkCardClass}${highlight} w-full text-left`}
						data-testid="approval-card"
						data-unread={true}
						onClick={() => setModalOpen(true)}
					>
						<CardBody approval={approval} showTeam={showTeam} unread />
					</button>
					<RepoSetupApprovalModal
						approval={approval}
						open={modalOpen}
						onOpenChange={setModalOpen}
					/>
				</>
			);
		}

		const dest = resolveOauthDestination(approval);
		return (
			<Link
				to={dest.to as never}
				params={dest.params as never}
				className={`${linkCardClass}${highlight}`}
				data-testid="approval-card"
				data-unread={true}
			>
				<CardBody approval={approval} showTeam={showTeam} unread />
			</Link>
		);
	}

	return (
		<div className={`${baseCardClass}${highlight}`} data-testid="approval-card" data-unread={true}>
			<CardBody approval={approval} showTeam={showTeam} unread />
			<div className="flex gap-2 mt-3 flex-wrap">
				{approval.type === ApprovalType.Hire && (
					<Link
						to="/projects/$projectId/agents/hire"
						params={{ projectId: approval.payload_project_slug ?? approval.team_slug }}
						search={{ approvalId: approval.id }}
					>
						<Button size="sm" variant="secondary" data-testid="approval-edit">
							<Pencil className="w-3 h-3" /> Edit & review
						</Button>
					</Link>
				)}
				{/* Hires are decided only on the edit/review page, never inline — the
				    proposal must be opened and reviewed before approve/deny. */}
				{approval.type !== ApprovalType.Hire && (
					<>
						<Button
							size="sm"
							variant="secondary"
							disabled={resolveApproval.isPending}
							onClick={() =>
								resolveApproval.mutate({
									approvalId: approval.id,
									status: ApprovalStatus.Approved,
									projectSlug: approval.payload_project_slug ?? undefined,
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
							className="text-danger"
							disabled={resolveApproval.isPending}
							onClick={() =>
								resolveApproval.mutate({
									approvalId: approval.id,
									status: ApprovalStatus.Denied,
									projectSlug: approval.payload_project_slug ?? undefined,
								})
							}
						>
							<X className="w-3 h-3" /> Deny
						</Button>
					</>
				)}
			</div>
		</div>
	);
}
