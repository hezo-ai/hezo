import {
	AgentAdminStatus,
	ApprovalStatus,
	type BudgetWindowsCents,
	CAPTAIN_AGENT_SLUG,
} from '@hezo/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Check, Loader2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { agentDisplayName } from '../../../../components/agent-identity-tooltip';
import {
	HireAgentForm,
	type HireFormValues,
	type ManagerOption,
	missingRequiredVars,
} from '../../../../components/hire-agent-form';
import { Button } from '../../../../components/ui/button';
import { type Agent, useAgents, useOnboardAgent } from '../../../../hooks/use-agents';
import {
	type Approval,
	type HireProposalEdits,
	useApprovals,
	useResolveApproval,
	useUpdateHireProposal,
} from '../../../../hooks/use-approvals';
import { useProjectMeta } from '../../../../hooks/use-projects';
import { useI18n } from '../../../../lib/i18n';

interface HireSearch {
	approvalId?: string;
}

/**
 * Default starter prompt for a new hire. It already contains every required
 * substitution variable so the form starts in a valid, editable state.
 */
const STARTER_SYSTEM_PROMPT = `You are a new agent at {{team_name}}.

You report to: {{reports_to}}.

Describe this agent's role and responsibilities here.

## Skills
{{skills_context}}

## Project documentation
{{project_docs_context}}

## Team preferences
{{team_preferences_context}}`;

const emptyValues: HireFormValues = {
	title: '',
	humanName: '',
	roleDesc: '',
	systemPrompt: STARTER_SYSTEM_PROMPT,
	// Default a new hire to reporting to the Captain (every team has one).
	reportsTo: CAPTAIN_AGENT_SLUG,
	budget: {
		daily_budget_cents: 0,
		weekly_budget_cents: 0,
		monthly_budget_cents: 2000,
	} satisfies BudgetWindowsCents,
	// Deliberately unset: the admin picks the cadence rather than inheriting a
	// prefilled one. The select is `required`, so submit is blocked until they do.
	heartbeat: '',
	touchesCode: false,
};

function valuesFromPayload(p: Record<string, unknown>): HireFormValues {
	return {
		title: (p.title as string) ?? '',
		humanName: (p.human_name as string) ?? '',
		roleDesc: (p.role_description as string) ?? '',
		systemPrompt: (p.system_prompt as string) ?? '',
		reportsTo: (p.reports_to as string) ?? '',
		budget: {
			daily_budget_cents: (p.daily_budget_cents as number) ?? 0,
			weekly_budget_cents: (p.weekly_budget_cents as number) ?? 0,
			monthly_budget_cents: (p.monthly_budget_cents as number) ?? 0,
		},
		// Kept verbatim, including a value outside the dropdown's presets - the form
		// renders it as its own option rather than rewriting the proposer's choice.
		heartbeat: p.heartbeat_interval_min == null ? '' : String(p.heartbeat_interval_min),
		touchesCode: (p.touches_code as boolean) ?? false,
	};
}

/**
 * The chosen cadence in minutes, or undefined while the select is still on its
 * placeholder. `required` on the select is what actually blocks submit; this
 * keeps an unset value from reaching the API as NaN if it ever gets that far.
 */
function heartbeatMinutes(v: HireFormValues): number | undefined {
	const parsed = Number.parseInt(v.heartbeat, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function editsFromValues(v: HireFormValues): HireProposalEdits {
	return {
		title: v.title,
		human_name: v.humanName,
		role_description: v.roleDesc,
		system_prompt: v.systemPrompt,
		reports_to: v.reportsTo,
		heartbeat_interval_min: heartbeatMinutes(v),
		daily_budget_cents: v.budget.daily_budget_cents,
		weekly_budget_cents: v.budget.weekly_budget_cents,
		monthly_budget_cents: v.budget.monthly_budget_cents,
		touches_code: v.touchesCode,
	};
}

/** Enabled, non-instance team agents selectable as a manager (excluding `excludeSlug`). */
function managerOptionsFrom(agents: Agent[] | undefined, excludeSlug?: string): ManagerOption[] {
	return (agents ?? [])
		.filter(
			(a) =>
				a.admin_status === AgentAdminStatus.Enabled && !a.is_instance && a.slug !== excludeSlug,
		)
		.map((a) => ({ slug: a.slug, title: agentDisplayName(a) }))
		.sort((x, y) => x.title.localeCompare(y.title));
}

function CreateHireForm({ projectId }: { projectId: string }) {
	const { t } = useI18n();
	const onboardAgent = useOnboardAgent(projectId);
	const navigate = useNavigate();
	const { data: agents } = useAgents(projectId);
	const managerOptions = useMemo(() => managerOptionsFrom(agents), [agents]);
	const [values, setValues] = useState<HireFormValues>(emptyValues);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await onboardAgent.mutateAsync({
			title: values.title,
			human_name: values.humanName || undefined,
			role_description: values.roleDesc || undefined,
			system_prompt: values.systemPrompt || undefined,
			reports_to: values.reportsTo || undefined,
			daily_budget_cents: values.budget.daily_budget_cents,
			weekly_budget_cents: values.budget.weekly_budget_cents,
			monthly_budget_cents: values.budget.monthly_budget_cents,
			heartbeat_interval_min: heartbeatMinutes(values),
			touches_code: values.touchesCode,
		});
		if (result.task) {
			navigate({
				to: '/projects/$projectId/tasks/$taskId',
				params: { projectId, taskId: result.task.identifier.toLowerCase() },
			});
		} else if (result.agent) {
			navigate({
				to: '/projects/$projectId/agents/$agentId',
				params: { projectId, agentId: result.agent.slug },
			});
		} else {
			navigate({ to: '/projects/$projectId/agents', params: { projectId } });
		}
	}

	return (
		<form onSubmit={handleSubmit}>
			{/* Back to the chooser rather than to the team page: a wrong turn at the
			    fork should cost one click, not a re-hunt for the button. */}
			<Link
				to="/projects/$projectId/agents"
				params={{ projectId }}
				search={{ hire: true }}
				className="mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-text-2 hover:text-text-1"
				data-testid="hire-back-to-chooser"
			>
				<ArrowLeft className="h-3.5 w-3.5" /> {t('agents.hire.back')}
			</Link>
			<HireAgentForm values={values} onChange={setValues} managerOptions={managerOptions} />
			{onboardAgent.error && (
				<p className="text-[13px] text-danger mt-4">
					{(onboardAgent.error as { message: string }).message}
				</p>
			)}
			<div className="flex justify-end gap-2 pt-4 mt-5 border-t border-border">
				<Link to="/projects/$projectId/agents" params={{ projectId }}>
					<Button type="button" variant="secondary">
						Cancel
					</Button>
				</Link>
				<Button
					type="submit"
					disabled={
						!values.title.trim() ||
						heartbeatMinutes(values) === undefined ||
						missingRequiredVars(values.systemPrompt).length > 0 ||
						onboardAgent.isPending
					}
				>
					{onboardAgent.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					Hire agent
				</Button>
			</div>
		</form>
	);
}

function EditHireProposal({ projectId, approval }: { projectId: string; approval: Approval }) {
	const navigate = useNavigate();
	const updateProposal = useUpdateHireProposal();
	const resolveApproval = useResolveApproval();

	const { data: agents } = useAgents(projectId);
	const editingSlug = (approval.payload.slug as string) ?? undefined;
	const managerOptions = useMemo(
		() => managerOptionsFrom(agents, editingSlug),
		[agents, editingSlug],
	);

	const initial = useMemo(() => valuesFromPayload(approval.payload), [approval.payload]);
	const [values, setValues] = useState<HireFormValues>(initial);
	const dirty = useMemo(
		() => JSON.stringify(values) !== JSON.stringify(initial),
		[values, initial],
	);
	const busy = updateProposal.isPending || resolveApproval.isPending;
	const promptInvalid = missingRequiredVars(values.systemPrompt).length > 0;

	function backToAgents() {
		navigate({ to: '/projects/$projectId/agents', params: { projectId } });
	}

	async function saveIfDirty() {
		if (dirty) {
			await updateProposal.mutateAsync({
				approvalId: approval.id,
				edits: editsFromValues(values),
				projectSlug: projectId,
			});
		}
	}

	async function handleSave() {
		await saveIfDirty();
	}

	async function handleApprove() {
		await saveIfDirty();
		await resolveApproval.mutateAsync({
			approvalId: approval.id,
			status: ApprovalStatus.Approved,
			projectSlug: projectId,
		});
		backToAgents();
	}

	async function handleDeny() {
		await resolveApproval.mutateAsync({
			approvalId: approval.id,
			status: ApprovalStatus.Denied,
			projectSlug: projectId,
		});
		backToAgents();
	}

	return (
		<div>
			<HireAgentForm
				values={values}
				onChange={setValues}
				slug={editingSlug}
				managerOptions={managerOptions}
			/>
			{updateProposal.error && (
				<p className="text-[13px] text-danger mt-4">
					{(updateProposal.error as { message: string }).message}
				</p>
			)}
			<div className="flex flex-wrap justify-end gap-2 pt-4 mt-5 border-t border-border">
				<Link to="/projects/$projectId/agents" params={{ projectId }}>
					<Button type="button" variant="secondary">
						Cancel
					</Button>
				</Link>
				<Button
					type="button"
					variant="ghost"
					className="text-danger"
					disabled={busy}
					onClick={handleDeny}
				>
					<X className="w-4 h-4" /> Deny
				</Button>
				<Button
					type="button"
					variant="secondary"
					disabled={busy || !dirty || promptInvalid}
					onClick={handleSave}
				>
					{updateProposal.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					Save changes
				</Button>
				<Button
					type="button"
					disabled={busy || !values.title.trim() || promptInvalid}
					onClick={handleApprove}
				>
					{resolveApproval.isPending ? (
						<Loader2 className="w-4 h-4 animate-spin" />
					) : (
						<Check className="w-4 h-4" />
					)}
					Approve hire
				</Button>
			</div>
		</div>
	);
}

function HireAgentPage() {
	const { t } = useI18n();
	const { projectId } = Route.useParams();
	const { approvalId } = Route.useSearch();
	const project = useProjectMeta(projectId);
	const { data: approvals, isLoading } = useApprovals(
		projectId,
		ApprovalStatus.Pending,
		!!approvalId,
	);

	// HQ is not staffed from the web app - see the team page. Only *starting* a hire
	// is blocked: a proposal the CEO filed against HQ over MCP still has to be
	// reviewable, or it would be stuck pending with nowhere to resolve it.
	if (!approvalId && project?.is_internal) {
		return (
			<p className="text-sm text-text-2" data-testid="hire-unavailable">
				{t('agents.hire.unavailableHq')}
			</p>
		);
	}

	if (!approvalId) return <CreateHireForm projectId={projectId} />;

	if (isLoading) {
		return (
			<div className="flex items-center gap-2 text-sm text-text-2">
				<Loader2 className="w-4 h-4 animate-spin" /> Loading proposal…
			</div>
		);
	}

	const approval = approvals?.find((a) => a.id === approvalId);
	if (!approval) {
		return (
			<p className="text-sm text-text-2">
				This hire proposal is no longer pending — it may have already been resolved.
			</p>
		);
	}

	return <EditHireProposal projectId={projectId} approval={approval} />;
}

export const Route = createFileRoute('/projects/$projectId/agents/hire')({
	validateSearch: (search: Record<string, unknown>): HireSearch => ({
		approvalId: typeof search.approvalId === 'string' ? search.approvalId : undefined,
	}),
	component: HireAgentPage,
});
