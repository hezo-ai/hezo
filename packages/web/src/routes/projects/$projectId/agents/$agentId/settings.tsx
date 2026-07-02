import {
	AgentAdminStatus,
	AI_PROVIDER_INFO,
	type AiProvider,
	type BudgetWindowsCents,
	CAPTAIN_AGENT_SLUG,
	hasFixedReportsTo,
	INSTANCE_AGENT_SLUGS,
} from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Loader2, Power, PowerOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BudgetWindowsEditor } from '../../../../../components/budget/budget-windows-editor';
import { MarkdownEditor } from '../../../../../components/markdown-editor';
import { RevisionsPanel } from '../../../../../components/revisions-panel';
import { Button } from '../../../../../components/ui/button';
import { ExpandableText } from '../../../../../components/ui/expandable-text';
import { Input } from '../../../../../components/ui/input';
import { Textarea } from '../../../../../components/ui/textarea';
import {
	useAgent,
	useAgentSystemPrompt,
	useAgentSystemPromptPreview,
	useAgentSystemPromptRevisions,
	useAgents,
	useDisableAgent,
	useEnableAgent,
	useRestoreAgentSystemPrompt,
	useUpdateAgent,
} from '../../../../../hooks/use-agents';
import { useAiProviderModels, useAiProviders } from '../../../../../hooks/use-ai-providers';
import { useBudgetStatus } from '../../../../../hooks/use-costs';

function AgentSettingsPage() {
	const { projectId, agentId } = Route.useParams();
	const { data: agent, isLoading } = useAgent(projectId, agentId);
	const { data: agents } = useAgents(projectId);
	const { data: promptDoc, isLoading: isPromptLoading } = useAgentSystemPrompt(projectId, agentId);
	const { data: revisions } = useAgentSystemPromptRevisions(projectId, agentId);
	const restorePrompt = useRestoreAgentSystemPrompt(projectId, agentId);
	const updateAgent = useUpdateAgent(projectId, agentId);
	const disableAgent = useDisableAgent(projectId);
	const enableAgent = useEnableAgent(projectId);
	const { data: budgetStatus } = useBudgetStatus(projectId);

	const [title, setTitle] = useState('');
	const [roleDesc, setRoleDesc] = useState('');
	const [systemPrompt, setSystemPrompt] = useState('');
	const [promptMode, setPromptMode] = useState<'edit' | 'preview'>('edit');
	const { data: previewData, isLoading: isPreviewLoading } = useAgentSystemPromptPreview(
		projectId,
		agentId,
		promptMode === 'preview',
	);
	const [reportsTo, setReportsTo] = useState('');
	const [budget, setBudget] = useState<BudgetWindowsCents>({
		daily_budget_cents: 0,
		weekly_budget_cents: 0,
		monthly_budget_cents: 0,
	});
	const [heartbeat, setHeartbeat] = useState('');
	const [runTimeout, setRunTimeout] = useState('');
	const [touchesCode, setTouchesCode] = useState(false);
	const [modelProvider, setModelProvider] = useState<AiProvider | ''>('');
	const [modelId, setModelId] = useState('');

	const initializedForAgentId = useRef<string | null>(null);
	useEffect(() => {
		if (!agent || initializedForAgentId.current === agent.id) return;
		initializedForAgentId.current = agent.id;
		setTitle(agent.title);
		setRoleDesc(agent.role_description ?? '');
		setReportsTo(agent.reports_to ?? '');
		setBudget({
			daily_budget_cents: agent.daily_budget_cents,
			weekly_budget_cents: agent.weekly_budget_cents,
			monthly_budget_cents: agent.monthly_budget_cents,
		});
		setHeartbeat(String(agent.heartbeat_interval_min));
		setRunTimeout(String(agent.run_timeout_min));
		setTouchesCode(agent.touches_code);
		setModelProvider((agent.model_override_provider ?? '') as AiProvider | '');
		setModelId(agent.model_override_model ?? '');
	}, [agent]);

	const initializedPromptForAgentId = useRef<string | null>(null);
	useEffect(() => {
		if (!promptDoc || initializedPromptForAgentId.current === agentId) return;
		initializedPromptForAgentId.current = agentId;
		setSystemPrompt(promptDoc.content);
	}, [promptDoc, agentId]);

	if (isLoading || !agent || isPromptLoading)
		return <div className="text-text-2 text-sm">Loading...</div>;

	const otherAgents =
		agents?.filter((a) => a.id !== agentId && a.admin_status !== AgentAdminStatus.Disabled) ?? [];

	// Captain, CEO, and Coach have structurally-fixed reporting lines (Captain → CEO;
	// CEO/Coach → admin) that must not be user-editable — mirrors the server guard.
	const reportsToLocked = hasFixedReportsTo(agent.slug);

	// The HQ instance singletons (CEO/Coach) are essential to the instance and can
	// never be disabled — mirrors the server guard on the disable route.
	const isInstanceAgent = (INSTANCE_AGENT_SLUGS as readonly string[]).includes(agent.slug);

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		const promptChanged = systemPrompt !== (promptDoc?.content ?? '');
		await updateAgent.mutateAsync({
			title,
			role_description: roleDesc || undefined,
			system_prompt: promptChanged ? systemPrompt : undefined,
			reports_to: reportsTo || null,
			daily_budget_cents: budget.daily_budget_cents,
			weekly_budget_cents: budget.weekly_budget_cents,
			monthly_budget_cents: budget.monthly_budget_cents,
			heartbeat_interval_min: Number.parseInt(heartbeat, 10),
			run_timeout_min: Number.parseInt(runTimeout, 10),
			touches_code: touchesCode,
			model_override_provider: modelProvider || null,
			model_override_model: modelProvider ? modelId || null : null,
		});
	}

	return (
		<div>
			{/* Budget & Heartbeat */}
			<div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
				<div className="rounded-lg border border-border-subtle bg-surface p-4">
					<div className="text-xs text-text-2 mb-2">Monthly spend</div>
					{(() => {
						const entry = budgetStatus?.agents.find((a) => a.agent_id === agent.id);
						const spent = entry?.monthly.spentCents ?? 0;
						const limit = agent.monthly_budget_cents;
						const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
						return (
							<>
								{limit > 0 && (
									<div className="h-2 rounded-full bg-surface-3 overflow-hidden mb-1">
										<div
											className={`h-full rounded-full transition-all ${pct > 80 ? 'bg-danger' : pct > 60 ? 'bg-warning' : 'bg-info'}`}
											style={{ width: `${Math.min(pct, 100)}%` }}
										/>
									</div>
								)}
								<div className="text-sm font-medium">
									${(spent / 100).toFixed(2)}
									{limit > 0 ? ` / $${(limit / 100).toFixed(2)} (${pct}%)` : ' (unlimited)'}
								</div>
								<Link
									to="/projects/$projectId/budget"
									params={{ projectId }}
									className="mt-1 inline-block text-xs text-info-soft-fg hover:underline"
								>
									View budgets & charts
								</Link>
							</>
						);
					})()}
				</div>
				<div className="rounded-lg border border-border-subtle bg-surface p-4">
					<div className="text-xs text-text-2 mb-2">Heartbeat</div>
					<div className="text-sm">Every {agent.heartbeat_interval_min} min</div>
					{agent.last_heartbeat_at && (
						<div className="text-xs text-text-3 mt-1">
							Last: {new Date(agent.last_heartbeat_at).toLocaleString()}
						</div>
					)}
				</div>
			</div>

			<form onSubmit={handleSave} className="flex flex-col gap-4">
				<Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
				<Textarea
					label="Role Description"
					value={roleDesc}
					onChange={(e) => setRoleDesc(e.target.value)}
				/>
				<div>
					<MarkdownEditor
						label="System Prompt"
						ariaLabel="System Prompt"
						value={systemPrompt}
						onChange={setSystemPrompt}
						defaultMode={promptMode}
						onModeChange={setPromptMode}
						className="min-h-[160px] font-mono text-xs"
						previewClassName="min-h-[160px]"
						previewTestId="system-prompt-preview"
						previewContent={previewData?.content ?? ''}
						isPreviewLoading={isPreviewLoading}
					/>
					<RevisionsPanel
						revisions={revisions}
						onRestore={(rev) => restorePrompt.mutateAsync(rev)}
						isRestoring={restorePrompt.isPending}
					/>
				</div>

				<label className="flex flex-col gap-1.5">
					<span className="text-sm text-text-2">Reports To</span>
					<select
						value={reportsTo}
						onChange={(e) => setReportsTo(e.target.value)}
						disabled={reportsToLocked}
						className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong disabled:opacity-60 disabled:cursor-not-allowed"
					>
						<option value="">None (Admin)</option>
						{otherAgents.map((a) => (
							<option key={a.id} value={a.id}>
								{a.title}
							</option>
						))}
					</select>
					{reportsToLocked && (
						<span data-testid="reports-to-locked-hint" className="text-xs text-text-2 italic">
							{agent.slug === CAPTAIN_AGENT_SLUG
								? 'The Captain always reports to the CEO; this reporting line is fixed.'
								: 'This role reports to the admin; its reporting line is fixed.'}
						</span>
					)}
				</label>

				<div className="flex flex-col gap-1.5">
					<span className="text-sm text-text-2">Team Relationships</span>
					<div
						data-testid="agent-team-context"
						className="rounded-md border border-border-subtle bg-surface-2 p-3 text-sm leading-relaxed text-text-1"
					>
						<ExpandableText
							text={agent.team_context ?? ''}
							placeholder={
								<span className="italic text-text-2">Team relationships being generated…</span>
							}
						/>
					</div>
					<p data-testid="agent-team-context-attribution" className="text-xs text-text-2 italic">
						Auto-generated by the Captain from the team's structure and system prompts. Injected
						into this agent's system prompt at the start of every run.
					</p>
				</div>

				<div className="flex flex-col gap-1.5">
					<span className="text-sm text-text-2">Budget limits</span>
					<BudgetWindowsEditor value={budget} onChange={setBudget} />
				</div>

				<div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
					<Input
						label="Heartbeat (min)"
						type="number"
						min="1"
						value={heartbeat}
						onChange={(e) => setHeartbeat(e.target.value)}
					/>
					<Input
						label="Run timeout (min)"
						type="number"
						min="1"
						value={runTimeout}
						onChange={(e) => setRunTimeout(e.target.value)}
					/>
				</div>

				<label className="flex items-start gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={touchesCode}
						onChange={(e) => setTouchesCode(e.target.checked)}
						className="mt-0.5"
					/>
					<span className="flex flex-col gap-0.5">
						<span className="text-[13px] text-text-1">Touches code</span>
						<span className="text-xs text-text-3">
							Enable if this agent reads or writes repository code. Agents that touch code require a
							designated repo on their project before they can run.
						</span>
					</span>
				</label>

				<ModelOverride
					provider={modelProvider}
					model={modelId}
					onProviderChange={(p) => {
						setModelProvider(p);
						setModelId('');
					}}
					onModelChange={setModelId}
				/>

				<div className="flex justify-end gap-2 mt-2">
					<Button type="submit" disabled={updateAgent.isPending}>
						{updateAgent.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
						Save Changes
					</Button>
				</div>
			</form>

			<div className="mt-8 pt-6 border-t border-border-subtle">
				<div className="text-sm font-medium mb-1">Agent status</div>
				<div className="text-xs text-text-2 mb-3">
					{isInstanceAgent
						? agent.admin_status === AgentAdminStatus.Enabled
							? 'This is an essential HQ role that runs coordination and review across every project. It is always active and cannot be disabled.'
							: 'This essential HQ role is currently disabled. Re-enable it to restore cross-project coordination and review.'
						: agent.admin_status === AgentAdminStatus.Enabled
							? 'Disabling unassigns this agent from open tasks and stops it from being scheduled.'
							: 'This agent is disabled and cannot be assigned new work. Enable to resume scheduling.'}
				</div>
				{/* The HQ instance singletons (CEO/Coach) can never be disabled — the disable
				    button is hidden for them — but if one is somehow disabled, the admin can
				    still re-enable it to recover. */}
				{!isInstanceAgent && agent.admin_status === AgentAdminStatus.Enabled && (
					<Button
						variant="secondary"
						size="sm"
						onClick={() => disableAgent.mutate(agentId)}
						disabled={disableAgent.isPending}
					>
						<PowerOff className="w-3 h-3" /> Disable agent
					</Button>
				)}
				{agent.admin_status === AgentAdminStatus.Disabled && (
					<Button
						variant="secondary"
						size="sm"
						onClick={() => enableAgent.mutate(agentId)}
						disabled={enableAgent.isPending}
					>
						<Power className="w-3 h-3" /> Enable agent
					</Button>
				)}
			</div>
		</div>
	);
}

interface ModelOverrideProps {
	provider: AiProvider | '';
	model: string;
	onProviderChange: (provider: AiProvider | '') => void;
	onModelChange: (model: string) => void;
}

function ModelOverride({ provider, model, onProviderChange, onModelChange }: ModelOverrideProps) {
	const { data: configs } = useAiProviders();

	const configByProvider = useMemo(() => {
		const map = new Map<string, { id: string; default_model: string | null }>();
		for (const c of configs ?? []) {
			if (c.status !== 'active') continue;
			if (!map.has(c.provider)) {
				map.set(c.provider, { id: c.id, default_model: c.default_model });
			}
		}
		return map;
	}, [configs]);

	const activeConfig = provider ? configByProvider.get(provider) : undefined;
	const models = useAiProviderModels(activeConfig?.id ?? '', {
		enabled: Boolean(activeConfig?.id),
	});

	const availableProviders = Array.from(configByProvider.keys()) as AiProvider[];

	return (
		<div className="rounded-lg border border-border-subtle bg-surface p-4 flex flex-col gap-3">
			<div>
				<div className="text-sm font-medium">Model override</div>
				<div className="text-xs text-text-2 mt-0.5">
					Override the model this agent runs on. When cleared, the agent uses the instance-default
					provider and its configured default model.
				</div>
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-xs text-text-2">Provider</span>
					<select
						aria-label="Model override provider"
						value={provider}
						onChange={(e) => onProviderChange((e.target.value as AiProvider) || '')}
						className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong"
					>
						<option value="">Use instance default</option>
						{availableProviders.map((p) => (
							<option key={p} value={p}>
								{AI_PROVIDER_INFO[p]?.name ?? p}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-text-2">Model</span>
					<select
						aria-label="Model override model"
						value={model}
						onChange={(e) => onModelChange(e.target.value)}
						disabled={!provider || models.isLoading}
						className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong disabled:opacity-60"
					>
						<option value="">
							{activeConfig?.default_model
								? `Provider default (${activeConfig.default_model})`
								: 'Provider default'}
						</option>
						{model && !models.data?.some((m) => m.id === model) && (
							<option value={model}>{model}</option>
						)}
						{models.data?.map((m) => (
							<option key={m.id} value={m.id}>
								{m.label}
							</option>
						))}
					</select>
					{models.error && (
						<span className="text-xs text-danger">
							{(models.error as { message?: string }).message || 'Failed to load models'}
						</span>
					)}
				</label>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/agents/$agentId/settings')({
	component: AgentSettingsPage,
});
