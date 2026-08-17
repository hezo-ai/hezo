import {
	GOAL_CHECK_FREQUENCY_LABELS,
	GoalCheckFrequency,
	type GoalWithProject,
} from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useCreateGoal, useUpdateGoal } from '../hooks/use-goals';
import { useI18n } from '../lib/i18n';
import { GoalSmartGuidance } from './goal-smart-guidance';
import { Button } from './ui/button';
import { DialogContent } from './ui/dialog';
import { InfoTooltip } from './ui/info-tooltip';
import { Input } from './ui/input';

interface CreateGoalDialogProps {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** When set, the dialog edits this goal instead of creating a new one. */
	goal?: GoalWithProject | null;
}

const textareaClass =
	'rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong';

/**
 * Normalize a goal's `target_date` into the `YYYY-MM-DD` value an `<input type="date">`
 * requires. `target_date` is a SQL `DATE` that serializes over the API as a UTC-midnight
 * ISO timestamp (e.g. "2026-09-30T00:00:00.000Z"); feeding that straight into a date input
 * leaves the field blank because the control only parses a bare calendar date. Take the UTC
 * calendar day, which is exactly the stored date. Returns '' for a missing/unparseable value.
 */
function toDateInputValue(value: string | null | undefined): string {
	if (!value) return '';
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return '';
	return d.toISOString().slice(0, 10);
}

/**
 * A field label row pairing the label text with an info tooltip suffix icon. Renders a `<span>` by
 * default (for fields whose control is wrapped by an outer `<label>`); pass `htmlFor` to render an
 * explicit `<label htmlFor>` instead (for controls that aren't a plain DOM element child).
 */
function FieldLabel({
	children,
	tooltip,
	tooltipLabel,
	htmlFor,
}: {
	children: ReactNode;
	tooltip: ReactNode;
	tooltipLabel: string;
	htmlFor?: string;
}) {
	const className = 'flex items-center gap-1.5 text-sm text-text-2';
	const inner = (
		<>
			{children}
			<InfoTooltip label={tooltipLabel} content={tooltip} />
		</>
	);
	return htmlFor ? (
		<label htmlFor={htmlFor} className={className}>
			{inner}
		</label>
	) : (
		<span className={className}>{inner}</span>
	);
}

export function CreateGoalDialog({ projectId, open, onOpenChange, goal }: CreateGoalDialogProps) {
	const { t } = useI18n();
	const isEdit = !!goal;
	const [title, setTitle] = useState('');
	const [measurement, setMeasurement] = useState('');
	const [actions, setActions] = useState('');
	const [checkFrequency, setCheckFrequency] = useState<GoalCheckFrequency>(
		GoalCheckFrequency.Daily,
	);
	const [targetDate, setTargetDate] = useState('');

	const createGoal = useCreateGoal(projectId);
	const updateGoal = useUpdateGoal(projectId, goal?.id ?? '');
	const pending = createGoal.isPending || updateGoal.isPending;
	const error = (createGoal.error ?? updateGoal.error) as { message: string } | null;

	// Seed the form from the goal being edited (or clear it for a fresh create) whenever the
	// dialog opens or the target goal changes.
	useEffect(() => {
		if (!open) return;
		setTitle(goal?.title ?? '');
		setMeasurement(goal?.measurement ?? '');
		setActions(goal?.actions ?? '');
		setCheckFrequency((goal?.check_frequency as GoalCheckFrequency) ?? GoalCheckFrequency.Daily);
		setTargetDate(toDateInputValue(goal?.target_date));
	}, [open, goal]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (isEdit) {
			await updateGoal.mutateAsync({
				title,
				measurement,
				actions,
				check_frequency: checkFrequency,
				target_date: targetDate || null,
			});
		} else {
			await createGoal.mutateAsync({
				title,
				measurement: measurement || undefined,
				actions: actions || undefined,
				check_frequency: checkFrequency,
				target_date: targetDate || undefined,
			});
		}
		onOpenChange(false);
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<DialogContent size="lg">
				<Dialog.Title className="text-lg font-semibold mb-4 pr-8">
					{isEdit ? 'Edit Goal' : 'Create Goal'}
				</Dialog.Title>

				<form onSubmit={handleSubmit} className="flex flex-col gap-4">
					<GoalSmartGuidance />

					<div className="flex flex-col gap-1.5">
						<FieldLabel
							htmlFor="goal-name"
							tooltipLabel="About goal name"
							tooltip="A short, outcome-focused name for the goal - what success looks like, not the work to get there."
						>
							Goal name
						</FieldLabel>
						<Input
							id="goal-name"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="e.g. Reach 100 paying customers"
							required
						/>
					</div>

					<label className="flex flex-col gap-1.5">
						<FieldLabel
							tooltipLabel="About measurement"
							tooltip="How will you know this goal is achieved? Be precise - this is the bar the Captain measures progress against."
						>
							Measurement
						</FieldLabel>
						<textarea
							value={measurement}
							onChange={(e) => setMeasurement(e.target.value)}
							placeholder="How will you know this goal is achieved? Be precise - this is the bar the Captain measures against."
							rows={3}
							className={textareaClass}
						/>
					</label>

					<label className="flex flex-col gap-1.5">
						<FieldLabel
							tooltipLabel="About suggested actions"
							tooltip="Optional - specific actions or checks the Captain should take toward this goal (e.g. run a weekly cron-style check of the signup funnel)."
						>
							Suggested actions <span className="text-text-3">(optional)</span>
						</FieldLabel>
						<textarea
							value={actions}
							onChange={(e) => setActions(e.target.value)}
							placeholder="Optional - specific actions or checks the Captain should take toward this goal (e.g. run a weekly cron-style check of the signup funnel)."
							rows={3}
							className={textareaClass}
						/>
					</label>

					<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
						<label className="flex flex-col gap-1.5">
							<FieldLabel
								tooltipLabel="About check frequency"
								tooltip="How often the Captain re-checks progress on this goal and acts on it."
							>
								Check frequency
							</FieldLabel>
							<select
								value={checkFrequency}
								onChange={(e) => setCheckFrequency(e.target.value as GoalCheckFrequency)}
								className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong"
							>
								{Object.entries(GOAL_CHECK_FREQUENCY_LABELS).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
						</label>

						<label className="flex flex-col gap-1.5">
							<FieldLabel
								tooltipLabel="About deadline"
								tooltip="Optional - a target date for reaching this goal. Leave blank for an open-ended goal."
							>
								Deadline <span className="text-text-3">(optional)</span>
							</FieldLabel>
							<input
								type="date"
								value={targetDate}
								onChange={(e) => setTargetDate(e.target.value)}
								className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong"
							/>
						</label>
					</div>

					{error && <p className="text-sm text-danger">{error.message}</p>}

					<div className="flex justify-end gap-2 mt-2">
						<Button
							type="button"
							variant="ghost"
							shortcut="Escape"
							shortcutFire={false}
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button type="submit" shortcut="mod+Enter" disabled={!title.trim() || pending}>
							{pending && <Loader2 className="w-4 h-4 animate-spin" />}
							{isEdit ? t('common.save') : 'Create'}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog.Root>
	);
}
