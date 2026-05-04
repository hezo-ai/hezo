import { ApprovalStatus, ApprovalType, OAuthRequestReason } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { Check, Loader2, X } from 'lucide-react';
import type { Approval } from '../hooks/use-approvals';
import { useResolveApproval } from '../hooks/use-approvals';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

const typeColors: Record<string, string> = {
	kb_update: 'blue',
	strategy: 'purple',
	designated_repo_request: 'yellow',
	secret_access: 'red',
	hire: 'green',
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
	const companySlug = approval.company_slug;

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
								<EntityLink
									to="/companies/$companyId/projects/$projectId"
									params={{ companyId: companySlug, projectId: projectSlug }}
								>
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
		case ApprovalType.Hire: {
			const title = (p.title as string) ?? 'a new agent';
			const issueId = approval.payload_issue_identifier;
			const issueProjectSlug = approval.payload_project_slug;
			return (
				<span>
					Proposing to hire <span className="font-medium">{title}</span>
					{issueId && (
						<>
							{' '}
							(
							{issueProjectSlug ? (
								<EntityLink
									to="/companies/$companyId/projects/$projectId/issues/$issueId"
									params={{
										companyId: companySlug,
										projectId: issueProjectSlug,
										issueId: issueId.toLowerCase(),
									}}
								>
									{issueId}
								</EntityLink>
							) : (
								<EntityLink
									to="/companies/$companyId/issues/$issueId"
									params={{ companyId: companySlug, issueId: issueId.toLowerCase() }}
								>
									{issueId}
								</EntityLink>
							)}
							)
						</>
					)}
				</span>
			);
		}
		case ApprovalType.KbUpdate: {
			const docTitle = (p.title as string) ?? 'a document';
			const changeSummary = p.change_summary as string | undefined;
			return (
				<>
					<span>
						Proposing update to KB doc "<span className="font-medium">{docTitle}</span>"
					</span>
					{changeSummary && (
						<span className="block text-xs text-text-muted mt-1">{changeSummary}</span>
					)}
				</>
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
	showCompany?: boolean;
}

const baseCardClass = 'block p-4 border border-border rounded-radius-md';
const linkCardClass = `${baseCardClass} hover:bg-bg-subtle transition-colors`;

function CardBody({ approval, showCompany }: { approval: Approval; showCompany: boolean }) {
	return (
		<>
			<div className="flex items-center gap-2 mb-1.5 flex-wrap">
				<Badge color={typeColors[approval.type] as 'gray'}>{approval.type.replace('_', ' ')}</Badge>
				{showCompany && approval.company_name && (
					<span className="text-xs text-text-muted">{approval.company_name}</span>
				)}
			</div>
			{approval.requested_by_name && (
				<p className="text-xs text-text-muted mb-1">From: {approval.requested_by_name}</p>
			)}
			<div className="text-sm text-text-subtle break-words">
				<ApprovalMessage approval={approval} />
			</div>
		</>
	);
}

function resolveOauthDestination(approval: Approval) {
	const reason = approval.payload.reason as string | undefined;
	const companySlug = approval.company_slug;

	if (reason === OAuthRequestReason.DesignatedRepo && approval.payload_issue_identifier) {
		if (approval.payload_project_slug) {
			return {
				to: '/companies/$companyId/projects/$projectId/issues/$issueId' as const,
				params: {
					companyId: companySlug,
					projectId: approval.payload_project_slug,
					issueId: approval.payload_issue_identifier.toLowerCase(),
				},
				hash: 'setup-repo',
			};
		}
		return {
			to: '/companies/$companyId/issues/$issueId' as const,
			params: { companyId: companySlug, issueId: approval.payload_issue_identifier.toLowerCase() },
			hash: 'setup-repo',
		};
	}
	if (reason === OAuthRequestReason.RepoAdd && approval.payload_project_slug) {
		return {
			to: '/companies/$companyId/projects/$projectId/settings' as const,
			params: { companyId: companySlug, projectId: approval.payload_project_slug },
		};
	}
	return {
		to: '/companies/$companyId/settings' as const,
		params: { companyId: companySlug },
	};
}

export function ApprovalCard({ approval, showCompany = false }: ApprovalCardProps) {
	const resolveApproval = useResolveApproval();

	if (approval.type === ApprovalType.DesignatedRepoRequest) {
		const dest = resolveOauthDestination(approval);
		return (
			<Link
				to={dest.to as never}
				params={dest.params as never}
				{...(dest.hash ? { hash: dest.hash } : {})}
				className={linkCardClass}
				data-testid="approval-card"
			>
				<CardBody approval={approval} showCompany={showCompany} />
			</Link>
		);
	}

	return (
		<div className={baseCardClass} data-testid="approval-card">
			<CardBody approval={approval} showCompany={showCompany} />
			<div className="flex gap-2 mt-3">
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
