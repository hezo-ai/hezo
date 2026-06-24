import type { BudgetWindowsCents } from '@hezo/shared';
import { BudgetWindowsEditor } from './budget/budget-windows-editor';
import { Input } from './ui/input';

export interface HireFormValues {
	title: string;
	roleDesc: string;
	systemPrompt: string;
	budget: BudgetWindowsCents;
	heartbeat: string;
	touchesCode: boolean;
}

const templateVars = [
	'{{team_name}}',
	'{{team_mission}}',
	'{{reports_to}}',
	'{{project_context}}',
	'{{kb_context}}',
	'{{agent_role}}',
];

interface HireAgentFormProps {
	values: HireFormValues;
	onChange: (values: HireFormValues) => void;
	/** When set, the (fixed) slug is shown read-only — used when editing a proposal. */
	slug?: string;
}

export function HireAgentForm({ values, onChange, slug }: HireAgentFormProps) {
	function set<K extends keyof HireFormValues>(key: K, value: HireFormValues[K]) {
		onChange({ ...values, [key]: value });
	}

	function insertVar(v: string) {
		const prev = values.systemPrompt;
		set('systemPrompt', `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${v}`);
	}

	return (
		<div className="flex flex-col gap-5">
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[500px]">
				<Input
					label="Role title"
					value={values.title}
					onChange={(e) => set('title', e.target.value)}
					required
					placeholder="e.g. Engineer, Data Scientist"
				/>
				<Input
					label="Role description"
					value={values.roleDesc}
					onChange={(e) => set('roleDesc', e.target.value)}
					placeholder="Brief description of responsibilities"
				/>
			</div>

			{slug && (
				<div className="flex flex-col gap-1.5 max-w-[500px]">
					<span className="text-xs font-medium uppercase tracking-wider text-text-2">Slug</span>
					<span className="font-mono text-[13px] text-text-2">{slug}</span>
				</div>
			)}

			<div className="flex flex-col gap-1.5 max-w-[190px]">
				<span className="text-xs font-medium uppercase tracking-wider text-text-2">Heartbeat</span>
				<select
					value={values.heartbeat}
					onChange={(e) => set('heartbeat', e.target.value)}
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
				<BudgetWindowsEditor value={values.budget} onChange={(b) => set('budget', b)} />
			</div>

			<label className="flex items-start gap-2 cursor-pointer max-w-[500px]">
				<input
					type="checkbox"
					checked={values.touchesCode}
					onChange={(e) => set('touchesCode', e.target.checked)}
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
					value={values.systemPrompt}
					onChange={(e) => set('systemPrompt', e.target.value)}
					className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-text-1 outline-none focus:border-border-strong min-h-[160px] resize-y font-mono leading-relaxed"
					placeholder="You are the {{agent_role}} at {{team_name}}..."
				/>
				<p className="text-xs text-text-3 mt-1">
					Insert variables using the chips above. Markdown supported.
				</p>
			</div>
		</div>
	);
}
