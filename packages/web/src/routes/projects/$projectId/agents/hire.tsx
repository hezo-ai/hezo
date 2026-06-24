import {
	ApprovalStatus,
	type BudgetWindowsCents,
	DEFAULT_HEARTBEAT_INTERVAL_MIN,
} from '@hezo/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Check, Loader2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { HireAgentForm, type HireFormValues } from '../../../../components/hire-agent-form';
import { Button } from '../../../../components/ui/button';
import { useOnboardAgent } from '../../../../hooks/use-agents';
import {
	type Approval,
	type HireProposalEdits,
	useApprovals,
	useResolveApproval,
	useUpdateHireProposal,
} from '../../../../hooks/use-approvals';

interface HireSearch {
	approvalId?: string;
}

const emptyValues: HireFormValues = {
	title: '',
	roleDesc: '',
	systemPrompt: '',
	budget: {
		daily_budget_cents: 0,
		weekly_budget_cents: 0,
		monthly_budget_cents: 2000,
	} satisfies BudgetWindowsCents,
	heartbeat: String(DEFAULT_HEARTBEAT_INTERVAL_MIN),
	touchesCode: false,
};

function valuesFromPayload(p: Record<string, unknown>): HireFormValues {
	return {
		title: (p.title as string) ?? '',
		roleDesc: (p.role_description as string) ?? '',
		systemPrompt: (p.system_prompt as string) ?? '',
		budget: {
			daily_budget_cents: (p.daily_budget_cents as number) ?? 0,
			weekly_budget_cents: (p.weekly_budget_cents as number) ?? 0,
			monthly_budget_cents: (p.monthly_budget_cents as number) ?? 0,
		},
		heartbeat: String((p.heartbeat_interval_min as number) ?? DEFAULT_HEARTBEAT_INTERVAL_MIN),
		touchesCode: (p.touches_code as boolean) ?? false,
	};
}

function editsFromValues(v: HireFormValues): HireProposalEdits {
	return {
		title: v.title,
		role_description: v.roleDesc,
		system_prompt: v.systemPrompt,
		heartbeat_interval_min: Number.parseInt(v.heartbeat, 10),
		daily_budget_cents: v.budget.daily_budget_cents,
		weekly_budget_cents: v.budget.weekly_budget_cents,
		monthly_budget_cents: v.budget.monthly_budget_cents,
		touches_code: v.touchesCode,
	};
}

function CreateHireForm({ projectId }: { projectId: string }) {
	const onboardAgent = useOnboardAgent(projectId);
	const navigate = useNavigate();
	const [values, setValues] = useState<HireFormValues>(emptyValues);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await onboardAgent.mutateAsync({
			title: values.title,
			role_description: values.roleDesc || undefined,
			system_prompt: values.systemPrompt || undefined,
			daily_budget_cents: values.budget.daily_budget_cents,
			weekly_budget_cents: values.budget.weekly_budget_cents,
			monthly_budget_cents: values.budget.monthly_budget_cents,
			heartbeat_interval_min: Number.parseInt(values.heartbeat, 10),
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
			<HireAgentForm values={values} onChange={setValues} />
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
				<Button type="submit" disabled={!values.title.trim() || onboardAgent.isPending}>
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

	const initial = useMemo(() => valuesFromPayload(approval.payload), [approval.payload]);
	const [values, setValues] = useState<HireFormValues>(initial);
	const dirty = useMemo(
		() => JSON.stringify(values) !== JSON.stringify(initial),
		[values, initial],
	);
	const busy = updateProposal.isPending || resolveApproval.isPending;

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
				slug={(approval.payload.slug as string) ?? undefined}
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
				<Button type="button" variant="secondary" disabled={busy || !dirty} onClick={handleSave}>
					{updateProposal.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
					Save changes
				</Button>
				<Button type="button" disabled={busy || !values.title.trim()} onClick={handleApprove}>
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
	const { projectId } = Route.useParams();
	const { approvalId } = Route.useSearch();
	const { data: approvals, isLoading } = useApprovals(
		projectId,
		ApprovalStatus.Pending,
		!!approvalId,
	);

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
