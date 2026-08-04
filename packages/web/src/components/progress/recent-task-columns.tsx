import {
	PROGRESS_ACTIVITY_KINDS,
	type ProgressActivity,
	type ProgressActivityEntry,
	type ProgressActivityKind,
} from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { MessageKey } from '../../lib/i18n';
import { useI18n } from '../../lib/i18n';
import { Tabs } from '../ui/tabs';

/**
 * The three recent-activity columns. Each row is a task the Captain chose during its last
 * progress-update run, with the one-line summary it wrote for it — so the copy here is content,
 * not UI strings, and is never translated.
 *
 * Desktop shows all three side by side; below `md` they collapse into a tab strip, because three
 * columns cannot survive a phone and the counts in the tabs keep the hidden panels legible.
 */
const COLUMN_LABELS: Record<ProgressActivityKind, { heading: MessageKey; tab: MessageKey }> = {
	actioned: { heading: 'progress.columns.actioned', tab: 'progress.tabs.actioned' },
	created: { heading: 'progress.columns.created', tab: 'progress.tabs.created' },
	closed: { heading: 'progress.columns.closed', tab: 'progress.tabs.closed' },
};

function TaskRow({ projectId, entry }: { projectId: string; entry: ProgressActivityEntry }) {
	// The whole row is a stretched link to the task; nothing else in it is interactive.
	return (
		<li className="relative transition-colors hover:bg-surface-2" data-testid="progress-task-row">
			<div className="flex flex-col gap-0.5 px-3 py-2.5">
				<div className="flex min-w-0 items-baseline gap-2">
					<Link
						to="/projects/$projectId/tasks/$taskId"
						params={{ projectId, taskId: entry.identifier.toLowerCase() }}
						data-testid="progress-task-link"
						className="font-mono text-[11.5px] text-info-soft-fg before:absolute before:inset-0"
					>
						{entry.identifier}
					</Link>
					<span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text-1">
						{entry.title}
					</span>
				</div>
				{/*
				 * Rendered in full, never clamped. The line is one finished sentence bounded at write
				 * time (`clampToWholeSentence`), so a `line-clamp` here would only cut a complete
				 * thought off mid-clause behind an ellipsis.
				 */}
				<p className="text-[11.5px] leading-relaxed text-text-3 break-words">{entry.summary}</p>
			</div>
		</li>
	);
}

function ColumnBody({
	projectId,
	entries,
	hasAnySnapshot,
}: {
	projectId: string;
	entries: ProgressActivityEntry[];
	hasAnySnapshot: boolean;
}) {
	const { t } = useI18n();
	if (entries.length === 0) {
		// Distinguish "the Captain looked and there was nothing" from "no progress update has
		// ever run here", which is the state a new project sits in and the one worth explaining.
		return (
			<div
				data-testid="progress-column-empty"
				className="rounded-md border border-border bg-surface px-3 py-6 text-center text-[12px] text-text-3"
			>
				{hasAnySnapshot ? t('progress.columns.empty') : t('progress.columns.awaitingRun')}
			</div>
		);
	}
	return (
		<ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
			{entries.map((entry) => (
				<TaskRow key={`${entry.identifier}-${entry.summary}`} projectId={projectId} entry={entry} />
			))}
		</ul>
	);
}

export function RecentTaskColumns({
	projectId,
	activity,
}: {
	projectId: string;
	activity: ProgressActivity;
}) {
	const { t } = useI18n();
	const [tab, setTab] = useState<ProgressActivityKind>('actioned');
	const hasAnySnapshot = PROGRESS_ACTIVITY_KINDS.some((k) => (activity[k]?.length ?? 0) > 0);

	return (
		<section data-testid="progress-columns">
			{/* Mobile: one tab strip over a single panel. */}
			<div className="md:hidden">
				<Tabs
					aria-label={t('progress.columns.tabsLabel')}
					value={tab}
					onValueChange={(key) => setTab(key as ProgressActivityKind)}
					className="mb-3"
					items={PROGRESS_ACTIVITY_KINDS.map((kind) => ({
						key: kind,
						label: t(COLUMN_LABELS[kind].tab),
						count: activity[kind]?.length || undefined,
						testId: `progress-tab-${kind}`,
					}))}
				/>
				<ColumnBody
					projectId={projectId}
					entries={activity[tab] ?? []}
					hasAnySnapshot={hasAnySnapshot}
				/>
			</div>

			{/* Tablet and up: all three side by side. */}
			<div className="hidden gap-4 md:grid md:grid-cols-3">
				{PROGRESS_ACTIVITY_KINDS.map((kind) => (
					<div key={kind} data-testid={`progress-column-${kind}`}>
						<div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
							<h2 className="text-[11px] font-medium uppercase tracking-wider text-text-3">
								{t(COLUMN_LABELS[kind].heading)}
							</h2>
							<Link
								to="/projects/$projectId/tasks"
								params={{ projectId }}
								className="text-[11px] text-text-3 transition-colors hover:text-text-1 hover:underline"
							>
								{t('progress.columns.allTasks')}
							</Link>
						</div>
						<ColumnBody
							projectId={projectId}
							entries={activity[kind] ?? []}
							hasAnySnapshot={hasAnySnapshot}
						/>
					</div>
				))}
			</div>
		</section>
	);
}
