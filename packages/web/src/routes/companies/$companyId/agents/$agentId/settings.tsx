import { AgentAdminStatus } from '@hezo/shared';
import { createFileRoute } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../../../components/ui/button';
import { Input } from '../../../../../components/ui/input';
import { Textarea } from '../../../../../components/ui/textarea';
import { useAgent, useAgents, useUpdateAgent } from '../../../../../hooks/use-agents';

function AgentSettingsPage() {
	const { companyId, agentId } = Route.useParams();
	const { data: agent, isLoading } = useAgent(companyId, agentId);
	const { data: agents } = useAgents(companyId);
	const updateAgent = useUpdateAgent(companyId, agentId);

	const [title, setTitle] = useState('');
	const [roleDesc, setRoleDesc] = useState('');
	const [systemPrompt, setSystemPrompt] = useState('');
	const [reportsTo, setReportsTo] = useState('');
	const [budget, setBudget] = useState('');
	const [heartbeat, setHeartbeat] = useState('');

	useEffect(() => {
		if (agent) {
			setTitle(agent.title);
			setRoleDesc(agent.role_description ?? '');
			setSystemPrompt(agent.system_prompt ?? '');
			setReportsTo(agent.reports_to ?? '');
			setBudget(String(agent.monthly_budget_cents / 100));
			setHeartbeat(String(agent.heartbeat_interval_min));
		}
	}, [agent]);

	if (isLoading || !agent) return <div className="text-text-muted text-sm">Loading...</div>;

	const otherAgents =
		agents?.filter((a) => a.id !== agentId && a.admin_status !== AgentAdminStatus.Terminated) ?? [];

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		await updateAgent.mutateAsync({
			title,
			role_description: roleDesc || undefined,
			system_prompt: systemPrompt || undefined,
			reports_to: reportsTo || null,
			monthly_budget_cents: Math.round(Number.parseFloat(budget) * 100),
			heartbeat_interval_min: Number.parseInt(heartbeat, 10),
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

				<div className="flex justify-end gap-2 mt-2">
					<Button type="submit" disabled={updateAgent.isPending}>
						{updateAgent.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
						Save Changes
					</Button>
				</div>
			</form>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/agents/$agentId/settings')({
	component: AgentSettingsPage,
});
