import { AgentAdminStatus, AI_PROVIDER_INFO, type AiProvider } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2, Power, PowerOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../../../components/ui/button';
import { Input } from '../../../../../components/ui/input';
import { Textarea } from '../../../../../components/ui/textarea';
import {
	useAgent,
	useAgents,
	useDisableAgent,
	useEnableAgent,
	useUpdateAgent,
} from '../../../../../hooks/use-agents';
import { useAiProviderModels, useAiProviders } from '../../../../../hooks/use-ai-providers';

function AgentSettingsPage() {
	const { companyId, agentId } = Route.useParams();
	const { data: agent, isLoading } = useAgent(companyId, agentId);
	const { data: agents } = useAgents(companyId);
	const updateAgent = useUpdateAgent(companyId, agentId);
	const disableAgent = useDisableAgent(companyId);
	const enableAgent = useEnableAgent(companyId);

	const [title, setTitle] = useState('');
	const [roleDesc, setRoleDesc] = useState('');
	const [systemPrompt, setSystemPrompt] = useState('');
	const [reportsTo, setReportsTo] = useState('');
	const [budget, setBudget] = useState('');
	const [heartbeat, setHeartbeat] = useState('');
	const [touchesCode, setTouchesCode] = useState(false);
	const [modelProvider, setModelProvider] = useState<AiProvider | ''>('');
	const [modelId, setModelId] = useState('');

	useEffect(() => {
		if (agent) {
			setTitle(agent.title);
			setRoleDesc(agent.role_description ?? '');
			setSystemPrompt(agent.system_prompt ?? '');
			setReportsTo(agent.reports_to ?? '');
			setBudget(String(agent.monthly_budget_cents / 100));
			setHeartbeat(String(agent.heartbeat_interval_min));
			setTouchesCode(agent.touches_code);
			setModelProvider((agent.model_override_provider ?? '') as AiProvider | '');
			setModelId(agent.model_override_model ?? '');
		}
	}, [agent]);

	if (isLoading || !agent) return <div className="text-text-muted text-sm">Loading...</div>;

	const otherAgents =
		agents?.filter((a) => a.id !== agentId && a.admin_status !== AgentAdminStatus.Disabled) ?? [];

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		await updateAgent.mutateAsync({
			title,
			role_description: roleDesc || undefined,
			system_prompt: systemPrompt || undefined,
			reports_to: reportsTo || null,
			monthly_budget_cents: Math.round(Number.parseFloat(budget) * 100),
			heartbeat_interval_min: Number.parseInt(heartbeat, 10),
			touches_code: touchesCode,
			model_override_provider: modelProvider || null,
			model_override_model: modelProvider ? modelId || null : null,
		});
	}

	return (
		<div>
			{/* Budget & Heartbeat */}
			<div className="mb-6 grid grid-cols-2 gap-4">
				<div className="rounded-lg border border-border-subtle bg-bg p-4">
					<div className="text-xs text-text-muted mb-2">Budget Usage</div>
					{(() => {
						const pct =
							agent.monthly_budget_cents > 0
								? Math.round((agent.budget_used_cents / agent.monthly_budget_cents) * 100)
								: 0;
						return (
							<>
								<div className="h-2 rounded-full bg-bg-muted overflow-hidden mb-1">
									<div
										className={`h-full rounded-full transition-all ${pct > 80 ? 'bg-danger' : pct > 60 ? 'bg-warning' : 'bg-primary'}`}
										style={{ width: `${Math.min(pct, 100)}%` }}
									/>
								</div>
								<div className="text-sm font-medium">
									{pct}% — ${(agent.budget_used_cents / 100).toFixed(2)} / $
									{(agent.monthly_budget_cents / 100).toFixed(2)}
								</div>
								{pct > 80 && (
									<div className="text-xs text-accent-red mt-1">Budget nearly exhausted</div>
								)}
							</>
						);
					})()}
				</div>
				<div className="rounded-lg border border-border-subtle bg-bg p-4">
					<div className="text-xs text-text-muted mb-2">Heartbeat</div>
					<div className="text-sm">Every {agent.heartbeat_interval_min} min</div>
					{agent.last_heartbeat_at && (
						<div className="text-xs text-text-subtle mt-1">
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
				<Textarea
					label="System Prompt"
					value={systemPrompt}
					onChange={(e) => setSystemPrompt(e.target.value)}
					className="min-h-[160px] font-mono text-xs"
				/>

				<label className="flex flex-col gap-1.5">
					<span className="text-sm text-text-muted">Reports To</span>
					<select
						value={reportsTo}
						onChange={(e) => setReportsTo(e.target.value)}
						className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
					>
						<option value="">None (Board)</option>
						{otherAgents.map((a) => (
							<option key={a.id} value={a.id}>
								{a.title}
							</option>
						))}
					</select>
				</label>

				<div className="grid grid-cols-2 gap-4">
					<Input
						label="Monthly Budget ($)"
						type="number"
						step="0.01"
						min="0"
						value={budget}
						onChange={(e) => setBudget(e.target.value)}
					/>
					<Input
						label="Heartbeat (min)"
						type="number"
						min="1"
						value={heartbeat}
						onChange={(e) => setHeartbeat(e.target.value)}
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
						<span className="text-[13px] text-text">Touches code</span>
						<span className="text-xs text-text-subtle">
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
				<div className="text-xs text-text-muted mb-3">
					{agent.admin_status === AgentAdminStatus.Enabled
						? 'Disabling unassigns this agent from open issues and stops it from being scheduled.'
						: 'This agent is disabled and cannot be assigned new work. Enable to resume scheduling.'}
				</div>
				{agent.admin_status === AgentAdminStatus.Enabled && (
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
		<div className="rounded-lg border border-border-subtle bg-bg p-4 flex flex-col gap-3">
			<div>
				<div className="text-sm font-medium">Model override</div>
				<div className="text-xs text-text-muted mt-0.5">
					Override the model this agent runs on. When cleared, the agent uses the instance-default
					provider and its configured default model.
				</div>
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
				<label className="flex flex-col gap-1">
					<span className="text-xs text-text-muted">Provider</span>
					<select
						aria-label="Model override provider"
						value={provider}
						onChange={(e) => onProviderChange((e.target.value as AiProvider) || '')}
						className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover"
					>
						<option value="">Use instance default</option>
						{availableProviders.map((p) => (
							<option key={p} value={p}>
								{AI_PROVIDER_INFO[p].name}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1">
					<span className="text-xs text-text-muted">Model</span>
					<select
						aria-label="Model override model"
						value={model}
						onChange={(e) => onModelChange(e.target.value)}
						disabled={!provider || models.isLoading}
						className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-border-hover disabled:opacity-60"
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
						<span className="text-xs text-accent-red">
							{(models.error as { message?: string }).message || 'Failed to load models'}
						</span>
					)}
				</label>
			</div>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/agents/$agentId/settings')({
	component: AgentSettingsPage,
});
