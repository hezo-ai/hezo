import {
	type BudgetWindowsCents,
	findMissingRequiredSystemPromptVars,
	HEARTBEAT_INTERVAL_FLOOR_MIN_DEFAULT,
	REQUIRED_SYSTEM_PROMPT_VARS,
	SYSTEM_PROMPT_TEMPLATE_VARS,
} from '@hezo/shared';
import { formatDuration } from '../lib/format-duration';
import { useI18n } from '../lib/i18n';
import { BudgetWindowsEditor } from './budget/budget-windows-editor';
import { type EditorChip, MarkdownEditor } from './markdown-editor';
import { Input } from './ui/input';

export interface HireFormValues {
	title: string;
	/** What the new teammate will be called. Blank leaves the naming to the Captain. */
	humanName: string;
	roleDesc: string;
	systemPrompt: string;
	/** Manager's slug this agent reports to ('' = no manager). */
	reportsTo: string;
	budget: BudgetWindowsCents;
	heartbeat: string;
	touchesCode: boolean;
}

/** A selectable manager for the reports-to dropdown. */
export interface ManagerOption {
	slug: string;
	title: string;
}

/** Variable chips for the prompt editor, sourced from the shared registry. */
const templateVars: EditorChip[] = SYSTEM_PROMPT_TEMPLATE_VARS.map((v) => ({
	token: v.token,
	description: v.description,
	required: v.required,
}));

/** Required vars missing from a prompt — empty when the prompt is acceptable. */
export function missingRequiredVars(systemPrompt: string): string[] {
	return findMissingRequiredSystemPromptVars(systemPrompt);
}

/**
 * Cadences offered in the heartbeat dropdown, in minutes. Starts at the
 * scheduler's floor: a shorter option would promise a tick that gets clamped.
 */
const HEARTBEAT_PRESETS_MIN = [HEARTBEAT_INTERVAL_FLOOR_MIN_DEFAULT, 120, 240, 720, 1440];

/**
 * The preset cadences, plus `current` when an agent-filed proposal carries a
 * value that is not one of them. Without this the select would render blank for
 * e.g. 90 and silently rewrite the Captain's choice on the admin's next save.
 */
export function heartbeatOptions(current: string): number[] {
	const parsed = Number.parseInt(current, 10);
	if (!Number.isFinite(parsed) || HEARTBEAT_PRESETS_MIN.includes(parsed)) {
		return HEARTBEAT_PRESETS_MIN;
	}
	return [...HEARTBEAT_PRESETS_MIN, parsed].sort((a, b) => a - b);
}

interface HireAgentFormProps {
	values: HireFormValues;
	onChange: (values: HireFormValues) => void;
	/** When set, the (fixed) slug is shown read-only — used when editing a proposal. */
	slug?: string;
	/** Agents on the team that can be selected as this agent's manager. */
	managerOptions?: ManagerOption[];
}

export function HireAgentForm({ values, onChange, slug, managerOptions = [] }: HireAgentFormProps) {
	const { t } = useI18n();

	function set<K extends keyof HireFormValues>(key: K, value: HireFormValues[K]) {
		onChange({ ...values, [key]: value });
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
					label="Name (optional)"
					value={values.humanName}
					onChange={(e) => set('humanName', e.target.value)}
					placeholder="e.g. Max"
				/>
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[500px]">
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

			<div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-[500px]">
				<div className="flex flex-col gap-1.5">
					<span className="text-xs font-medium uppercase tracking-wider text-text-2">
						Reports to
					</span>
					<select
						aria-label="Reports to"
						value={values.reportsTo}
						onChange={(e) => set('reportsTo', e.target.value)}
						className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-text-1 outline-none focus:border-border-strong"
					>
						<option value="">No manager</option>
						{managerOptions.map((m) => (
							<option key={m.slug} value={m.slug}>
								{m.title}
							</option>
						))}
					</select>
					<span className="text-xs text-text-3">
						Sets the reporting line so work can be delegated to and from this agent.
					</span>
				</div>

				<div className="flex flex-col gap-1.5 max-w-[190px]">
					<span className="text-xs font-medium uppercase tracking-wider text-text-2">
						Heartbeat
					</span>
					<select
						aria-label="Heartbeat"
						required
						value={values.heartbeat}
						onChange={(e) => set('heartbeat', e.target.value)}
						className="rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-text-1 outline-none focus:border-border-strong"
					>
						{/* Empty and disabled so a new hire starts unselected: the cadence
						    is a deliberate choice, never a value the admin inherited by
						    not looking at the field. `required` blocks submit until picked. */}
						<option value="" disabled>
							{t('agents.hire.heartbeatPlaceholder')}
						</option>
						{heartbeatOptions(values.heartbeat).map((min) => (
							<option key={min} value={String(min)}>
								{formatDuration(min * 60)}
							</option>
						))}
					</select>
					<span className="text-xs text-text-3">
						{t('agents.hire.heartbeatHelp', { min: String(HEARTBEAT_INTERVAL_FLOOR_MIN_DEFAULT) })}
					</span>
				</div>
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

			<div className="flex flex-col gap-1.5">
				<MarkdownEditor
					label="System prompt"
					labelClassName="text-xs font-medium uppercase tracking-wider text-text-2"
					ariaLabel="System prompt"
					value={values.systemPrompt}
					onChange={(v) => set('systemPrompt', v)}
					chips={templateVars}
					placeholder="You are the Engineer at {{team_name}}..."
					helpText="Hover a chip (tap on mobile) for what each variable means. Markdown supported."
					className="min-h-[160px] font-mono"
					previewClassName="min-h-[160px]"
					emptyPreviewText="_(nothing to preview)_"
				/>
				<SystemPromptVarGuidance systemPrompt={values.systemPrompt} />
			</div>
		</div>
	);
}

/**
 * Guidance + live validation beneath the prompt editor: spells out that every
 * required substitution variable must be present for the prompt to be accepted,
 * and flags any that are currently missing.
 */
function SystemPromptVarGuidance({ systemPrompt }: { systemPrompt: string }) {
	const missing = missingRequiredVars(systemPrompt);
	return (
		<div className="text-xs">
			<p className="text-text-3">
				The prompt must include all required variables (marked{' '}
				<span className="text-danger">*</span>) to be accepted:{' '}
				<span className="font-mono">{REQUIRED_SYSTEM_PROMPT_VARS.join(', ')}</span>.
			</p>
			{missing.length > 0 && (
				<p className="text-danger mt-1" role="alert">
					Missing required variable{missing.length > 1 ? 's' : ''}:{' '}
					<span className="font-mono">{missing.join(', ')}</span>
				</p>
			)}
		</div>
	);
}
