import {
	GOAL_CHECK_FREQUENCY_LABELS,
	GoalCheckFrequency,
	type GoalWithProject,
} from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCreateGoal, useUpdateGoal } from '../hooks/use-goals';
import { GoalSmartGuidance } from './goal-smart-guidance';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
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

export function CreateGoalDialog({ projectId, open, onOpenChange, goal }: CreateGoalDialogProps) {
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
		setTargetDate(goal?.target_date ?? '');
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
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.lg}>
					<div className="flex items-center justify-between mb-4">
						<Dialog.Title className="text-lg font-semibold">
							{isEdit ? 'Edit Goal' : 'Create Goal'}
						</Dialog.Title>
						<Dialog.Close asChild>
							<button
								type="button"
								className="text-text-2 hover:text-text-1 p-2 -m-2"
								aria-label="Close"
							>
								<X className="w-4 h-4" />
							</button>
						</Dialog.Close>
					</div>

					<form onSubmit={handleSubmit} className="flex flex-col gap-4">
						<GoalSmartGuidance />

						<Input
							label="Goal name"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="e.g. Reach 100 paying customers"
							required
						/>

						<label className="flex flex-col gap-1.5">
							<span className="text-sm text-text-2">Measurement</span>
							<textarea
								value={measurement}
								onChange={(e) => setMeasurement(e.target.value)}
								placeholder="How will you know this goal is achieved? Be precise — this is the bar the Captain measures against."
								rows={3}
								className={textareaClass}
							/>
						</label>

						<label className="flex flex-col gap-1.5">
							<span className="text-sm text-text-2">
								Suggested actions <span className="text-text-3">(optional)</span>
							</span>
							<textarea
								value={actions}
								onChange={(e) => setActions(e.target.value)}
								placeholder="Optional — specific actions or checks the Captain should take toward this goal (e.g. run a weekly cron-style check of the signup funnel)."
								rows={3}
								className={textareaClass}
							/>
						</label>

						<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
							<label className="flex flex-col gap-1.5">
								<span className="text-sm text-text-2">Check frequency</span>
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
								<span className="text-sm text-text-2">
									Deadline <span className="text-text-3">(optional)</span>
								</span>
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
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!title.trim() || pending}>
								{pending && <Loader2 className="w-4 h-4 animate-spin" />}
								{isEdit ? 'Save' : 'Create'}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
