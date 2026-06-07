import { ApprovalStatus, ApprovalType, OAuthRequestReason } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Check, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import type { Approval } from '../hooks/use-approvals';
import { useResolveApproval } from '../hooks/use-approvals';
import { RepoSetupApprovalModal } from './repo-setup-approval-modal';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const typeColors: Record<string, string> = {
	strategy: 'purple',
	designated_repo_request: 'yellow',
	secret_access: 'red',
	hire: 'green',
	team_template: 'green',
	plan_review: 'blue',
	deploy_production: 'red',
	skill_proposal: 'blue',
};

const linkClass = 'font-medium text-accent-blue-text hover:underline';

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
		case ApprovalType.SecretAccess: {
			const secretName = p.secret_name as string;
			const projectName = approval.payload_project_name;
			const projectSlug = approval.payload_project_slug;
			return (
				<>
					<span>
						Requesting access to secret "<span className="font-medium">{secretName}</span>"
						{projectSlug && projectName && (
							<>
								{' '}
								in project{' '}
								<EntityLink to="/projects/$projectId" params={{ projectId: projectSlug }}>
									{projectName}
								</EntityLink>
							</>
						)}
					</span>
					{p.reason && (
						<span className="block text-xs text-text-muted mt-1">{p.reason as string}</span>
					)}
				</>
			);
		}
		case ApprovalType.TeamTemplate: {
			const templateName = (p.template_name as string) ?? 'Team template';
			const rationale = p.rationale as string | undefined;
			const roles = (p.roles as Array<{ name: string; slug: string }> | undefined) ?? [];
			const hireTaskId = p.task_id as string | undefined;
			const hireTaskIdentifier = approval.payload_task_identifier;
			const hireProjectSlug = approval.payload_project_slug;
			return (
				<>
					<span>
						Approve provisioning the <span className="font-medium">{templateName}</span> team
						template
						{hireTaskIdentifier && hireProjectSlug && (
							<>
								{' '}
								(
								<EntityLink
									to="/projects/$projectId/tasks/$taskId"
									params={{
										projectId: hireProjectSlug,
										taskId: hireTaskIdentifier.toLowerCase(),
									}}
								>
									{hireTaskIdentifier}
								</EntityLink>
								)
							</>
						)}
					</span>
					{rationale && <span className="block text-xs text-text-muted mt-1">{rationale}</span>}
					{roles.length > 0 && (
						<span className="block text-xs text-text-muted mt-1">
							Roles: {roles.map((r) => r.name).join(', ')}
						</span>
					)}
					{hireTaskId && !hireTaskIdentifier && (
						<span className="block text-xs text-text-subtle mt-1">
							Linked to hire-the-team intake
						</span>
					)}
				</>
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
					{p.reason && (
						<span className="block text-xs text-text-muted mt-1">{p.reason as string}</span>
					)}
				</>
			);
		}
		case ApprovalType.PlanReview: {
			return (
				<>
					<span>Requesting plan review</span>
					{p.reason && (
						<span className="block text-xs text-text-muted mt-1">{p.reason as string}</span>
					)}
				</>
			);
		}
		case ApprovalType.Strategy: {
			const plan = p.plan as string | undefined;
			return (
				<>
					<span>Proposing strategy</span>
					{plan && <span className="block text-xs text-text-muted mt-1">{plan}</span>}
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
					{p.reason && (
						<span className="block text-xs text-text-muted mt-1">{p.reason as string}</span>
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

const baseCardClass = 'block p-4 border border-border rounded-radius-md';
const linkCardClass = `${baseCardClass} hover:bg-bg-subtle transition-colors`;

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
						className="w-2 h-2 rounded-full bg-primary shrink-0"
					/>
				)}
				<Badge color={typeColors[approval.type] as 'gray'}>{approval.type.replace('_', ' ')}</Badge>
				{resolved && (
					<Badge color={approval.status === ApprovalStatus.Approved ? 'green' : 'red'}>
						{approval.status}
					</Badge>
				)}
				{showTeam && approval.team_name && (
					<span className="text-xs text-text-muted">{approval.team_name}</span>
				)}
			</div>
			{approval.requested_by_name && (
				<p className="text-xs text-text-muted mb-1">From: {approval.requested_by_name}</p>
			)}
			<div className="text-sm text-text-subtle break-words">
				<ApprovalMessage approval={approval} />
			</div>
			{resolved && approval.resolution_note && (
				<p className="text-xs text-text-muted mt-2">Note: {approval.resolution_note}</p>
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
	const highlight = unread ? ' border-l-2 border-l-primary bg-bg-subtle' : '';

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
			<div className="flex gap-2 mt-3">
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
					className="text-accent-red"
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
			</div>
		</div>
	);
}
