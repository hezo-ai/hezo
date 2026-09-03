import { Loader2, Pencil, Timer } from 'lucide-react';
import { useState } from 'react';
import { useSetMonthlyContainerHours } from '../../hooks/use-container-hours';
import { useI18n } from '../../lib/i18n';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SectionHeader } from '../ui/section-header';

/**
 * The instance-wide monthly container-hours allowance.
 *
 * **Gates container starts, not runs.** At the allowance no new container is
 * provisioned, while runs that land on a container already up proceed - they
 * spend no new hours, and idling a container the instance is paying for either
 * way would help nobody. It clears when the calendar month turns, not when
 * something frees up, which is why a run parked on it says so in its own words
 * rather than borrowing the at-capacity wording.
 *
 * Invalidate-and-refetch rather than optimistic, like every other control that
 * gates real work: the stored figure is what admission reads, so it must not
 * appear in force before the server has it.
 */
export function MonthlyHoursCap({ monthlyHours }: { monthlyHours: number }) {
	const { t } = useI18n();
	const setCap = useSetMonthlyContainerHours();
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState('');

	function startEditing() {
		// Blank rather than "0" for no cap: 0 is how it is stored, but an operator
		// setting a limit should not have to clear a placeholder figure first.
		setValue(monthlyHours > 0 ? String(monthlyHours) : '');
		setEditing(true);
	}

	async function save() {
		const parsed = Number.parseInt(value, 10);
		await setCap.mutateAsync(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
		setEditing(false);
	}

	return (
		<section data-testid="monthly-hours-cap">
			<SectionHeader
				icon={Timer}
				title={t('budget.hours.cap.title')}
				description={t('budget.hours.cap.description')}
				action={
					!editing && (
						<Button
							variant="ghost"
							size="sm"
							onClick={startEditing}
							data-testid="edit-monthly-hours-cap"
						>
							<Pencil className="h-3.5 w-3.5" aria-hidden />
							{t('budget.hours.cap.edit')}
						</Button>
					)
				}
			/>

			{editing ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
					className="flex flex-col gap-3 sm:flex-row sm:items-end"
				>
					<Input
						type="number"
						min="0"
						step="1"
						label={t('budget.hours.cap.label')}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder={t('budget.hours.cap.placeholder')}
						data-testid="monthly-hours-cap-input"
						wrapperClassName="sm:w-56"
					/>
					<div className="flex gap-2">
						<Button type="submit" size="sm" disabled={setCap.isPending}>
							{setCap.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : t('common.save')}
						</Button>
						<Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
							{t('common.cancel')}
						</Button>
					</div>
				</form>
			) : (
				<div className="rounded-lg border border-border bg-surface p-4 shadow-xs">
					<p className="text-[13px] text-text-1" data-testid="monthly-hours-cap-value">
						{monthlyHours > 0
							? t('budget.hours.cap.set', { hours: String(monthlyHours) })
							: t('budget.hours.cap.unset')}
					</p>
				</div>
			)}
		</section>
	);
}
