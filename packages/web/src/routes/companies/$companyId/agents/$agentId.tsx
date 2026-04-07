import { AgentAdminStatus, AgentRuntimeStatus } from '@hezo/shared';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, Loader2, Power, PowerOff, Skull } from 'lucide-react';
import { useEffect, useState } from 'react';
import { RUNTIME_BADGE } from '../../../../components/agent-status-label';
import { Badge } from '../../../../components/ui/badge';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import {
	useAgent,
	useAgents,
	useDisableAgent,
	useEnableAgent,
	useTerminateAgent,
	useUpdateAgent,
} from '../../../../hooks/use-agents';
import { useHeartbeatRuns } from '../../../../hooks/use-heartbeat-runs';

function AgentDetailPage() {
	const { companyId, agentId } = Route.useParams();
	const { data: agent, isLoading } = useAgent(companyId, agentId);
	const { data: agents } = useAgents(companyId);
	const updateAgent = useUpdateAgent(companyId, agentId);
	const disableAgent = useDisableAgent(companyId);
	const enableAgent = useEnableAgent(companyId);
	const terminateAgent = useTerminateAgent(companyId);
	const { data: heartbeatRuns } = useHeartbeatRuns(companyId, agentId);

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

	if (isLoading || !agent) return <div className="p-6 text-text-muted">Loading...</div>;

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
		<div className="p-6 max-w-2xl">
			<Link
				to="/companies/$companyId/agents"
				params={{ companyId }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Team
			</Link>

			<div className="flex items-center gap-3 mb-6">
				<h1
					className={`text-lg font-semibold${agent.admin_status === AgentAdminStatus.Disabled ? ' text-text-muted' : ''}`}
				>
					{agent.title}
					{agent.admin_status === AgentAdminStatus.Disabled ? ' (disabled)' : ''}
				</h1>
				{agent.admin_status === AgentAdminStatus.Terminated ? (
					<Badge color="gray">Terminated</Badge>
				) : (
					<Badge
						color={
							(RUNTIME_BADGE[agent.runtime_status] ?? RUNTIME_BADGE[AgentRuntimeStatus.Idle])
								.color as 'gray'
						}
					>
						{(RUNTIME_BADGE[agent.runtime_status] ?? RUNTIME_BADGE[AgentRuntimeStatus.Idle]).label}
					</Badge>
				)}
			</div>

			<div className="flex gap-2 mb-6">
				{agent.admin_status === AgentAdminStatus.Enabled && (
					<Button variant="secondary" size="sm" onClick={() => disableAgent.mutate(agentId)}>
						<PowerOff className="w-3 h-3" /> Disable
					</Button>
				)}
				{agent.admin_status === AgentAdminStatus.Disabled && (
					<Button variant="secondary" size="sm" onClick={() => enableAgent.mutate(agentId)}>
						<Power className="w-3 h-3" /> Enable
					</Button>
				)}
				{agent.admin_status !== AgentAdminStatus.Terminated && (
					<Button
						variant="destructive"
						size="sm"
						onClick={() => {
							if (confirm('Terminate this agent?')) terminateAgent.mutate(agentId);
						}}
					>
						<Skull className="w-3 h-3" /> Terminate
					</Button>
				)}
			</div>

			{/* Budget & Status */}
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

			{/* Recent Heartbeat Runs */}
			{heartbeatRuns && heartbeatRuns.length > 0 && (
				<div className="mb-6">
					<h2 className="text-sm font-medium text-text-muted mb-2">Recent Runs</h2>
					<div className="flex flex-col gap-1">
						{heartbeatRuns.slice(0, 5).map((run) => (
							<div
								key={run.id}
								className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg px-3 py-2 text-xs"
							>
								<Badge
									color={
										run.status === 'completed'
											? 'green'
											: run.status === 'failed'
												? 'red'
												: 'yellow'
									}
								>
									{run.status}
								</Badge>
								<span className="text-text-muted">{new Date(run.started_at).toLocaleString()}</span>
								{run.exit_code !== null && (
									<span className="text-text-subtle ml-auto">exit: {run.exit_code}</span>
								)}
								{run.error && (
									<span className="text-accent-red ml-2 truncate max-w-[200px]">{run.error}</span>
								)}
							</div>
						))}
					</div>
				</div>
			)}

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

export const Route = createFileRoute('/companies/$companyId/agents/$agentId')({
	component: AgentDetailPage,
});
