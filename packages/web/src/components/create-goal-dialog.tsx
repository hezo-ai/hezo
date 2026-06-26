import { GOAL_CHECK_FREQUENCY_LABELS, GoalCheckFrequency } from '@hezo/shared';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { useCreateGoal } from '../hooks/use-goals';
import { Button } from './ui/button';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
import { Input } from './ui/input';

interface CreateGoalDialogProps {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function CreateGoalDialog({ projectId, open, onOpenChange }: CreateGoalDialogProps) {
	const [title, setTitle] = useState('');
	const [description, setDescription] = useState('');
	const [checkFrequency, setCheckFrequency] = useState<GoalCheckFrequency>(
		GoalCheckFrequency.Daily,
	);
	const [targetDate, setTargetDate] = useState('');
	const createGoal = useCreateGoal(projectId);

	function reset() {
		setTitle('');
		setDescription('');
		setCheckFrequency(GoalCheckFrequency.Daily);
		setTargetDate('');
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		await createGoal.mutateAsync({
			title,
			description: description || undefined,
			check_frequency: checkFrequency,
			target_date: targetDate || undefined,
		});
		onOpenChange(false);
		reset();
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.lg}>
					<div className="flex items-center justify-between mb-4">
						<Dialog.Title className="text-lg font-semibold">Create Goal</Dialog.Title>
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
						<Input
							label="Title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							required
						/>

						<label className="flex flex-col gap-1.5">
							<span className="text-sm text-text-2">Description</span>
							<textarea
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Optional"
								rows={4}
								className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong"
							/>
							<span className="text-xs text-text-3">
								Make it Specific, Measurable, Achievable, Relevant, and Time-bound.
							</span>
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
								<span className="text-sm text-text-2">Target date</span>
								<input
									type="date"
									value={targetDate}
									onChange={(e) => setTargetDate(e.target.value)}
									className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-strong"
								/>
							</label>
						</div>

						{createGoal.error && (
							<p className="text-sm text-danger">
								{(createGoal.error as { message: string }).message}
							</p>
						)}

						<div className="flex justify-end gap-2 mt-2">
							<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!title.trim() || createGoal.isPending}>
								{createGoal.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
								Create
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
