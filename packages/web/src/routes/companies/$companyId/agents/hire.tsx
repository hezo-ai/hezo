import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { useAgents, useCreateAgent } from '../../../../hooks/use-agents';

const templateVars = [
	'{{company_name}}',
	'{{company_mission}}',
	'{{reports_to}}',
	'{{project_context}}',
	'{{kb_context}}',
	'{{agent_role}}',
];

function HireAgentPage() {
	const { companyId } = Route.useParams();
	const { data: agents } = useAgents(companyId);
	const createAgent = useCreateAgent(companyId);
	const navigate = useNavigate();

	const [title, setTitle] = useState('');
	const [roleDesc, setRoleDesc] = useState('');
	const [systemPrompt, setSystemPrompt] = useState('');
	const [reportsTo, setReportsTo] = useState('');
	const [runtime, setRuntime] = useState('claude_code');
	const [budget, setBudget] = useState('20');
	const [heartbeat, setHeartbeat] = useState('60');

	const otherAgents = agents?.filter((a) => a.admin_status !== 'terminated') ?? [];

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await createAgent.mutateAsync({
			title,
			role_description: roleDesc || undefined,
			system_prompt: systemPrompt || undefined,
			reports_to: reportsTo || undefined,
			runtime_type: runtime,
			monthly_budget_cents: Math.round(Number.parseFloat(budget) * 100),
			heartbeat_interval_min: Number.parseInt(heartbeat, 10),
		});
		navigate({
			to: '/companies/$companyId/agents/$agentId',
			params: { companyId, agentId: result.id },
		});
	}

	function insertVar(v: string) {
		setSystemPrompt((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${v}`);
	}

	return (
		<div>
			<form onSubmit={handleSubmit} className="flex flex-col gap-5">
				<div className="grid grid-cols-2 gap-4 max-w-[500px]">
					<Input
						label="Role title"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						required
						placeholder="e.g. Engineer, Data Scientist"
					/>
					<Input
						label="Slug"
						value={roleDesc}
						onChange={(e) => setRoleDesc(e.target.value)}
						placeholder="e.g. engineer"
					/>
				</div>

				<div className="grid grid-cols-3 gap-4 max-w-[600px]">
					<div className="flex flex-col gap-1.5">
						<span className="text-xs font-medium uppercase tracking-wider text-text-muted">
							Runtime
						</span>
						<select
							value={runtime}
							onChange={(e) => setRuntime(e.target.value)}
							className="rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-border-hover"
						>
							<option value="claude_code">Claude Code</option>
							<option value="codex">Codex</option>
							<option value="gemini">Gemini</option>
						</select>
					</div>
					<div className="flex flex-col gap-1.5">
						<span className="text-xs font-medium uppercase tracking-wider text-text-muted">
							Reports to
						</span>
						<select
							value={reportsTo}
							onChange={(e) => setReportsTo(e.target.value)}
							className="rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-border-hover"
						>
							<option value="">None (Board)</option>
							{otherAgents.map((a) => (
								<option key={a.id} value={a.id}>
									{a.title}
								</option>
							))}
						</select>
					</div>
					<div className="flex flex-col gap-1.5">
						<span className="text-xs font-medium uppercase tracking-wider text-text-muted">
							Heartbeat
						</span>
						<select
							value={heartbeat}
							onChange={(e) => setHeartbeat(e.target.value)}
							className="rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-border-hover"
						>
							<option value="30">30m</option>
							<option value="60">60m</option>
							<option value="120">2h</option>
							<option value="240">4h</option>
							<option value="720">12h</option>
							<option value="1440">24h</option>
						</select>
					</div>
				</div>

				<Input
					label="Monthly budget"
					type="number"
					step="0.01"
					min="0"
					value={budget}
					onChange={(e) => setBudget(e.target.value)}
					className="max-w-[140px]"
				/>

				<div>
					<span className="text-xs font-medium uppercase tracking-wider text-text-muted block mb-1.5">
						System prompt
					</span>
					<div className="flex flex-wrap gap-1.5 mb-2">
						{templateVars.map((v) => (
							<button
								key={v}
								type="button"
								onClick={() => insertVar(v)}
								className="text-[11px] px-2 py-0.5 rounded-radius-md bg-accent-blue-bg text-accent-blue-text cursor-pointer hover:opacity-80"
							>
								{v}
							</button>
						))}
					</div>
					<textarea
						value={systemPrompt}
						onChange={(e) => setSystemPrompt(e.target.value)}
						className="w-full rounded-radius-md border border-border bg-bg px-3 py-2 text-[13px] text-text outline-none focus:border-border-hover min-h-[160px] resize-y font-mono leading-relaxed"
						placeholder="You are the {{agent_role}} at {{company_name}}..."
					/>
					<p className="text-xs text-text-subtle mt-1">
						Insert variables using the chips above. Markdown supported.
					</p>
				</div>

				{createAgent.error && (
					<p className="text-[13px] text-accent-red">
						{(createAgent.error as { message: string }).message}
					</p>
				)}

				<div className="flex justify-end gap-2 pt-4 border-t border-border">
					<Link to="/companies/$companyId/agents" params={{ companyId }}>
						<Button type="button" variant="secondary">
							Cancel
						</Button>
					</Link>
					<Button type="submit" disabled={!title.trim() || createAgent.isPending}>
						{createAgent.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
						Hire agent
					</Button>
				</div>
			</form>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/agents/hire')({
	component: HireAgentPage,
});
