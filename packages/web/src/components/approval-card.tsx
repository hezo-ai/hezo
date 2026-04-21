import { ApprovalStatus, ApprovalType } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
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
	system_prompt_update: 'purple',
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
		case ApprovalType.SystemPromptUpdate: {
			const agentName = approval.payload_member_name ?? 'an agent';
			const agentSlug = approval.payload_member_slug ?? (p.member_id as string);
			return (
				<>
					<span>
						Wants to update{' '}
						{agentSlug ? (
							<EntityLink
								to="/companies/$companyId/agents/$agentId"
								params={{ companyId: companySlug, agentId: agentSlug }}
							>
								{agentName}
							</EntityLink>
						) : (
							<span className="font-medium">{agentName}</span>
						)}
						's system prompt
					</span>
					{p.reason && (
						<span className="block text-xs text-text-muted mt-1">{p.reason as string}</span>
					)}
				</>
			);
		}
		case ApprovalType.OauthRequest: {
			const platform = (p.platform as string) ?? 'GitHub';
			const reason = p.reason as string | undefined;
			const projectName = approval.payload_project_name;
			const projectSlug = approval.payload_project_slug;
			const action =
				reason === 'designated_repo'
					? 'set up the designated repo for'
					: reason === 'repo_add'
						? 'add a repo to'
						: 'access';
			return (
				<span>
					Requesting {platform} OAuth to {action}{' '}
					{projectSlug && projectName ? (
						<>
							project{' '}
							<EntityLink
								to="/companies/$companyId/projects/$projectId"
								params={{ companyId: companySlug, projectId: projectSlug }}
							>
								{projectName}
							</EntityLink>
						</>
					) : projectName ? (
						<>
							project <span className="font-medium">{projectName}</span>
						</>
					) : null}
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
			return (
				<span>
					Proposing to hire <span className="font-medium">{title}</span>
					{issueId && (
						<>
							{' '}
							(
							<EntityLink
								to="/companies/$companyId/issues/$issueId"
								params={{ companyId: companySlug, issueId: issueId.toLowerCase() }}
							>
								{issueId}
							</EntityLink>
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

export function ApprovalCard({ approval, showCompany = false }: ApprovalCardProps) {
	const resolveApproval = useResolveApproval();

	return (
		<div className="p-4 border border-border rounded-radius-md" data-testid="approval-card">
			<div className="flex items-center gap-2 mb-1.5 flex-wrap">
				<Badge color={typeColors[approval.type] as 'gray'}>{approval.type.replace('_', ' ')}</Badge>
				{showCompany && approval.company_name && (
					<span className="text-xs text-text-muted">{approval.company_name}</span>
				)}
			</div>
			{approval.requested_by_name && (
				<p className="text-xs text-text-muted mb-1">From: {approval.requested_by_name}</p>
			)}
			<div className="text-sm text-text-subtle mb-3 break-words">
				<ApprovalMessage approval={approval} />
			</div>
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
