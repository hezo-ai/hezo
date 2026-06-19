import { useEffect, useState } from 'react';
import { DEFAULT_SUBTASK_PAGE_SIZE, type Team, useUpdateTeam } from '../../hooks/use-teams';
import { Input } from '../ui/input';
import { SectionHeader } from './helpers';

export function AutomationsSection({
	projectId,
	team,
}: {
	projectId: string;
	team: Team | undefined;
}) {
	const updateTeam = useUpdateTeam(projectId);
	const wakeOnReply = team?.settings?.wake_mentioner_on_reply ?? true;
	const savedPageSize = team?.settings?.subtask_page_size ?? DEFAULT_SUBTASK_PAGE_SIZE;
	const [pageSizeInput, setPageSizeInput] = useState<string>(String(savedPageSize));

	useEffect(() => {
		setPageSizeInput(String(savedPageSize));
	}, [savedPageSize]);

	async function toggleWakeOnReply(next: boolean) {
		await updateTeam.mutateAsync({ settings: { wake_mentioner_on_reply: next } });
	}

	async function commitPageSize() {
		const parsed = Math.floor(Number(pageSizeInput));
		if (!Number.isFinite(parsed) || parsed < 1) {
			setPageSizeInput(String(savedPageSize));
			return;
		}
		const clamped = Math.min(500, parsed);
		setPageSizeInput(String(clamped));
		if (clamped === savedPageSize) return;
		await updateTeam.mutateAsync({ settings: { subtask_page_size: clamped } });
	}

	return (
		<section>
			<SectionHeader title="Automations" desc="Per-team toggles for agent coordination behavior." />
			<label className="flex items-start gap-3 text-[13px] max-w-xl cursor-pointer select-none">
				<input
					type="checkbox"
					className="mt-0.5"
					checked={wakeOnReply}
					disabled={!team || updateTeam.isPending}
					onChange={(e) => toggleWakeOnReply(e.target.checked)}
				/>
				<span>
					<span className="font-medium block">Wake mentioner on reply</span>
					<span className="text-text-2 block mt-0.5">
						When an agent replies to a comment that @-mentioned it, automatically wake the original
						commenter so they see the response right away. Disable to have the original commenter
						pick up accumulated replies on their next heartbeat instead — useful when a single
						comment @-mentions several agents and you'd rather batch their responses.
					</span>
				</span>
			</label>
			<div className="mt-5 pt-5 border-t border-border-subtle max-w-xl">
				<label htmlFor="subtask-page-size" className="block text-[13px] font-medium">
					Sub-task page size
				</label>
				<p className="text-text-2 text-[13px] mt-0.5 mb-1.5">
					How many sub-tasks to show on an task page before a "Show more" link is offered.
				</p>
				<Input
					id="subtask-page-size"
					type="number"
					min={1}
					max={500}
					step={1}
					value={pageSizeInput}
					onChange={(e) => setPageSizeInput(e.target.value)}
					onBlur={commitPageSize}
					onKeyDown={(e) => {
						if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
					}}
					disabled={!team || updateTeam.isPending}
					className="w-24"
					data-testid="subtask-page-size-input"
				/>
			</div>
		</section>
	);
}
