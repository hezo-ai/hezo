import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { useAgents, useCreateAgent } from '../../../../hooks/use-agents';

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

	const otherAgents = agents?.filter((a) => a.status !== 'terminated') ?? [];

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

	return (
		<div className="p-6 max-w-2xl">
			<Link
				to="/companies/$companyId/agents"
				params={{ companyId }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Agents
			</Link>

			<h1 className="text-lg font-semibold mb-6">Hire Agent</h1>

			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				<Input
					label="Title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					required
					placeholder="e.g. Frontend Engineer"
				/>
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

				<div className="grid grid-cols-2 gap-4">
					<label className="flex flex-col gap-1.5">
						<span className="text-sm text-text-muted">Runtime</span>
						<select
							value={runtime}
							onChange={(e) => setRuntime(e.target.value)}
							className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-primary"
						>
							<option value="claude_code">Claude Code</option>
							<option value="codex">Codex</option>
							<option value="gemini">Gemini</option>
						</select>
					</label>
					<label className="flex flex-col gap-1.5">
						<span className="text-sm text-text-muted">Reports To</span>
						<select
							value={reportsTo}
							onChange={(e) => setReportsTo(e.target.value)}
							className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text outline-none focus:border-primary"
						>
							<option value="">None (Board)</option>
							{otherAgents.map((a) => (
								<option key={a.id} value={a.id}>
									{a.title}
								</option>
							))}
						</select>
					</label>
				</div>

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

				{createAgent.error && (
					<p className="text-sm text-danger">
						{(createAgent.error as { message: string }).message}
					</p>
				)}

				<div className="flex justify-end gap-2 mt-2">
					<Link to="/companies/$companyId/agents" params={{ companyId }}>
						<Button type="button" variant="ghost">
							Cancel
						</Button>
					</Link>
					<Button type="submit" disabled={!title.trim() || createAgent.isPending}>
						{createAgent.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
						Hire
					</Button>
				</div>
			</form>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/agents/hire')({
	component: HireAgentPage,
});
