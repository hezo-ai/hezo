import { OPERATIONS_PROJECT_SLUG } from '@hezo/shared';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { useOnboardAgent } from '../../../../hooks/use-agents';

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
	const onboardAgent = useOnboardAgent(companyId);
	const navigate = useNavigate();

	const [title, setTitle] = useState('');
	const [roleDesc, setRoleDesc] = useState('');
	const [systemPrompt, setSystemPrompt] = useState('');
	const [budget, setBudget] = useState('20');
	const [heartbeat, setHeartbeat] = useState('60');
	const [touchesCode, setTouchesCode] = useState(false);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await onboardAgent.mutateAsync({
			title,
			role_description: roleDesc || undefined,
			system_prompt: systemPrompt || undefined,
			monthly_budget_cents: Math.round(Number.parseFloat(budget) * 100),
			heartbeat_interval_min: Number.parseInt(heartbeat, 10),
			touches_code: touchesCode,
		});
		if (result.issue) {
			navigate({
				to: '/companies/$companyId/projects/$projectId/issues/$issueId',
				params: {
					companyId,
					projectId: OPERATIONS_PROJECT_SLUG,
					issueId: result.issue.identifier.toLowerCase(),
				},
			});
		} else if (result.agent) {
			navigate({
				to: '/companies/$companyId/agents/$agentId',
				params: { companyId, agentId: result.agent.id },
			});
		} else {
			navigate({ to: '/companies/$companyId/agents', params: { companyId } });
		}
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
						label="Role description"
						value={roleDesc}
						onChange={(e) => setRoleDesc(e.target.value)}
						placeholder="Brief description of responsibilities"
					/>
				</div>

				<div className="flex flex-col gap-1.5 max-w-[190px]">
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

				<Input
					label="Monthly budget"
					type="number"
					step="0.01"
					min="0"
					value={budget}
					onChange={(e) => setBudget(e.target.value)}
					className="max-w-[140px]"
				/>

				<label className="flex items-start gap-2 cursor-pointer max-w-[500px]">
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

				{onboardAgent.error && (
					<p className="text-[13px] text-accent-red">
						{(onboardAgent.error as { message: string }).message}
					</p>
				)}

				<div className="flex justify-end gap-2 pt-4 border-t border-border">
					<Link to="/companies/$companyId/agents" params={{ companyId }}>
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

export const Route = createFileRoute('/companies/$companyId/agents/hire')({
	component: HireAgentPage,
});
