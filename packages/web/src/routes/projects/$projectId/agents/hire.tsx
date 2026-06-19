import type { BudgetWindowsCents } from '@hezo/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { BudgetWindowsEditor } from '../../../../components/budget/budget-windows-editor';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { useOnboardAgent } from '../../../../hooks/use-agents';
import { useResolvedTeam } from '../../../../hooks/use-projects';

const templateVars = [
	'{{team_name}}',
	'{{team_mission}}',
	'{{reports_to}}',
	'{{project_context}}',
	'{{kb_context}}',
	'{{agent_role}}',
];

function HireAgentPage() {
	const { projectId } = Route.useParams();
	const onboardAgent = useOnboardAgent(projectId);
	const team = useResolvedTeam(projectId);
	const navigate = useNavigate();

	const [title, setTitle] = useState('');
	const [roleDesc, setRoleDesc] = useState('');
	const [systemPrompt, setSystemPrompt] = useState('');
	const [budget, setBudget] = useState<BudgetWindowsCents>({
		daily_budget_cents: 0,
		weekly_budget_cents: 0,
		monthly_budget_cents: 2000,
	});
	const [heartbeat, setHeartbeat] = useState('60');
	const [touchesCode, setTouchesCode] = useState(false);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await onboardAgent.mutateAsync({
			title,
			role_description: roleDesc || undefined,
			system_prompt: systemPrompt || undefined,
			daily_budget_cents: budget.daily_budget_cents,
			weekly_budget_cents: budget.weekly_budget_cents,
			monthly_budget_cents: budget.monthly_budget_cents,
			heartbeat_interval_min: Number.parseInt(heartbeat, 10),
			touches_code: touchesCode,
		});
		if (result.task) {
			navigate({
				to: '/projects/$projectId/tasks/$taskId',
				params: {
					projectId,
					taskId: result.task.identifier.toLowerCase(),
				},
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

	function insertVar(v: string) {
		setSystemPrompt((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${v}`);
	}

	return (
		<div>
			<form onSubmit={handleSubmit} className="flex flex-col gap-5">
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[500px]">
					<Input
						label="Role title"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						required
						placeholder="e.g. Engineer, Data Scientist"
					/>
					<Input
						label="Role description"
						value={roleDesc}
						onChange={(e) => setRoleDesc(e.target.value)}
						placeholder="Brief description of responsibilities"
					/>
				</div>

				<div className="flex flex-col gap-1.5 max-w-[190px]">
					<span className="text-xs font-medium uppercase tracking-wider text-text-2">
						Heartbeat
					</span>
					<select
						value={heartbeat}
						onChange={(e) => setHeartbeat(e.target.value)}
						className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-text-1 outline-none focus:border-border-strong"
					>
						<option value="30">30m</option>
						<option value="60">60m</option>
						<option value="120">2h</option>
						<option value="240">4h</option>
						<option value="720">12h</option>
						<option value="1440">24h</option>
					</select>
				</div>

				<div className="flex flex-col gap-1.5 max-w-[500px]">
					<span className="text-xs font-medium uppercase tracking-wider text-text-2">
						Budget limits
					</span>
					<BudgetWindowsEditor value={budget} onChange={setBudget} />
				</div>

				<label className="flex items-start gap-2 cursor-pointer max-w-[500px]">
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

				<div>
					<span className="text-xs font-medium uppercase tracking-wider text-text-2 block mb-1.5">
						System prompt
					</span>
					<div className="flex flex-wrap gap-1.5 mb-2">
						{templateVars.map((v) => (
							<button
								key={v}
								type="button"
								onClick={() => insertVar(v)}
								className="text-[11px] px-2 py-0.5 rounded-md bg-info-soft text-info-soft-fg cursor-pointer hover:opacity-80"
							>
								{v}
							</button>
						))}
					</div>
					<textarea
						value={systemPrompt}
						onChange={(e) => setSystemPrompt(e.target.value)}
						className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-text-1 outline-none focus:border-border-strong min-h-[160px] resize-y font-mono leading-relaxed"
						placeholder="You are the {{agent_role}} at {{team_name}}..."
					/>
					<p className="text-xs text-text-3 mt-1">
						Insert variables using the chips above. Markdown supported.
					</p>
				</div>

				{onboardAgent.error && (
					<p className="text-[13px] text-danger">
						{(onboardAgent.error as { message: string }).message}
					</p>
				)}

				<div className="flex justify-end gap-2 pt-4 border-t border-border">
					<Link to="/projects/$projectId/agents" params={{ projectId }}>
						<Button type="button" variant="secondary">
							Cancel
						</Button>
					</Link>
					<Button type="submit" disabled={!title.trim() || onboardAgent.isPending}>
						{onboardAgent.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
						Hire agent
					</Button>
				</div>
			</form>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId/agents/hire')({
	component: HireAgentPage,
});
