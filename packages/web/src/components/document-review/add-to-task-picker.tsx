import { Hash, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePanelPlacement } from '../../hooks/use-panel-placement';
import { useTasks } from '../../hooks/use-tasks';
import { Button } from '../ui/button';
import type { ReviewTaskContext } from './action-review-dialog';

/**
 * Filter input plus the former `max-h-56` list, now the whole panel's design
 * cap: the panel is the scroll container (the filter row sticks to its top), so
 * `usePanelPlacement` can read a content height its own clamp doesn't move.
 */
const PANEL_MAX_HEIGHT_PX = 264;

interface TaskRow {
	/** Lowercase identifier — the `:taskId` API path segment. */
	taskId: string;
	identifier: string;
	title: string;
	status: string | null;
	isCurrent: boolean;
}

interface AddToTaskPickerProps {
	/** Route-param project slug (query keys + API paths). */
	projectId: string;
	/** The hosting task when the dialog was opened from a task view — pinned first in the list. */
	currentTask?: ReviewTaskContext;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Disables the trigger and rows while a post is in flight. */
	pending: boolean;
	/** Lowercase id of the in-flight target — puts the spinner on that row. */
	pendingTaskId: string | null;
	onSelect: (target: { taskId: string; identifier: string }) => void;
}

/**
 * "Add to task": a filterable dropdown of the project's tasks, opened from the
 * action-review dialog's footer. Hand-rolled absolute panel (MentionPicker
 * style) rather than a body-portaled popover — the trigger already sits inside
 * a modal dialog. `usePanelPlacement` picks the side: it prefers upward, the
 * trigger being a dialog-footer button, and drops below only when there is no
 * room above. Selecting a row posts the handoff to that task immediately.
 */
export function AddToTaskPicker({
	projectId,
	currentTask,
	open,
	onOpenChange,
	pending,
	pendingTaskId,
	onSelect,
}: AddToTaskPickerProps) {
	const [query, setQuery] = useState('');
	const [debouncedQuery, setDebouncedQuery] = useState('');
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const anchorRef = useRef<HTMLDivElement>(null);

	// Fresh filter on every open.
	useEffect(() => {
		if (!open) return;
		setQuery('');
		setDebouncedQuery('');
		setHighlightedIndex(0);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const id = setTimeout(() => setDebouncedQuery(query), 150);
		return () => clearTimeout(id);
	}, [query, open]);

	const { data, isFetching } = useTasks(
		projectId,
		{ search: debouncedQuery || undefined, per_page: '20', sort: 'updated_at:desc' },
		{ enabled: open },
	);

	const rows = useMemo<TaskRow[]>(() => {
		const fetched = data?.data ?? [];
		const isCurrent = (identifier: string) => identifier.toLowerCase() === currentTask?.taskId;
		const rest: TaskRow[] = fetched
			.filter((t) => !isCurrent(t.identifier))
			.map((t) => ({
				taskId: t.identifier.toLowerCase(),
				identifier: t.identifier,
				title: t.title,
				status: t.status,
				isCurrent: false,
			}));
		if (!currentTask) return rest;
		const fetchedCurrent = fetched.find((t) => isCurrent(t.identifier));
		// Pinned first row: with no filter it's synthesized from the context (so
		// it leads even when outside the server page); with a filter it appears
		// only if the search matched it.
		if (!debouncedQuery || fetchedCurrent) {
			return [
				{
					taskId: currentTask.taskId,
					identifier: currentTask.identifier,
					title: fetchedCurrent?.title ?? currentTask.title ?? currentTask.identifier,
					status: fetchedCurrent?.status ?? null,
					isCurrent: true,
				},
				...rest,
			];
		}
		return rest;
	}, [data, currentTask, debouncedQuery]);

	const { panelRef, side, sideClassName, style } = usePanelPlacement<HTMLDivElement>(anchorRef, {
		open,
		prefer: 'top',
		preferredMaxHeight: PANEL_MAX_HEIGHT_PX,
		deps: [rows, isFetching],
	});

	useEffect(() => {
		if (highlightedIndex >= rows.length) setHighlightedIndex(0);
	}, [rows, highlightedIndex]);

	useEffect(() => {
		const el = panelRef.current?.querySelector<HTMLElement>(
			`[data-task-idx="${highlightedIndex}"]`,
		);
		if (el) el.scrollIntoView({ block: 'nearest' });
	}, [highlightedIndex, panelRef]);

	// Tracks the blur-close timer so we can cancel it on unmount. Without this
	// the timer fires after the component is gone — in happy-dom teardown that
	// throws "window is not defined" and breaks the test scheduled right after.
	const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (blurTimerRef.current !== null) {
				clearTimeout(blurTimerRef.current);
				blurTimerRef.current = null;
			}
		};
	}, []);

	function handleBlur() {
		if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
		blurTimerRef.current = setTimeout(() => {
			blurTimerRef.current = null;
			onOpenChange(false);
		}, 100);
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onOpenChange(false);
			return;
		}
		if (rows.length === 0) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setHighlightedIndex((i) => (i + 1) % rows.length);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setHighlightedIndex((i) => (i - 1 + rows.length) % rows.length);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const row = rows[highlightedIndex] ?? rows[0];
			if (!pending) onSelect({ taskId: row.taskId, identifier: row.identifier });
		}
	}

	return (
		<div ref={anchorRef} className="relative">
			<Button
				size="sm"
				onClick={() => onOpenChange(!open)}
				disabled={pending}
				aria-label="Add to task"
				aria-haspopup="listbox"
				aria-expanded={open}
				data-testid="action-review-add"
			>
				{pending && <Loader2 className="h-3 w-3 animate-spin" />}
				Add to task…
			</Button>
			{open && (
				<div
					ref={panelRef}
					className={`absolute right-0 z-10 ${sideClassName} w-72 max-w-[calc(100vw-3rem)] overflow-y-auto rounded-md border border-border bg-surface shadow-md`}
					style={style}
					data-placement={side}
					data-testid="add-to-task-picker"
				>
					<input
						// biome-ignore lint/a11y/noAutofocus: the picker is an on-demand filter popup — focus lands in the filter by design
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={handleKeyDown}
						onBlur={handleBlur}
						placeholder="Filter tasks…"
						aria-label="Filter tasks"
						data-testid="add-to-task-filter"
						className="sticky top-0 z-10 w-full border-b border-border bg-surface px-3 py-2 text-[13px] text-text-1 outline-none placeholder:text-text-3"
					/>
					<div role="listbox" className="p-1">
						{isFetching && rows.length === 0 && (
							<div className="px-3 py-2 text-xs text-text-2">Searching…</div>
						)}
						{!isFetching && rows.length === 0 && (
							<div className="px-3 py-2 text-xs text-text-2">
								{debouncedQuery
									? `No tasks matching "${debouncedQuery}"`
									: 'No tasks in this project'}
							</div>
						)}
						{rows.map((row, idx) => (
							<button
								key={row.taskId}
								type="button"
								role="option"
								aria-selected={idx === highlightedIndex}
								disabled={pending}
								data-task-idx={idx}
								data-task-id={row.taskId}
								data-testid={row.isCurrent ? 'add-to-task-current' : 'add-to-task-option'}
								onMouseDown={(e) => {
									// Keep focus in the filter input so blur doesn't close first.
									e.preventDefault();
									if (!pending) onSelect({ taskId: row.taskId, identifier: row.identifier });
								}}
								onMouseEnter={() => setHighlightedIndex(idx)}
								className={`flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-[13px] disabled:opacity-60 ${
									idx === highlightedIndex ? 'bg-surface-2' : ''
								}`}
							>
								{pendingTaskId === row.taskId ? (
									<Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-2" />
								) : (
									<Hash className="h-3.5 w-3.5 shrink-0 text-text-2" />
								)}
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-text-1">{row.title}</span>
									<span className="truncate text-[11px] text-text-3">
										{row.identifier}
										{row.status ? ` · ${row.status.replace(/_/g, ' ')}` : ''}
									</span>
								</div>
								{row.isCurrent && (
									<span className="ml-2 shrink-0 text-[10px] uppercase tracking-wider text-text-3">
										Current task
									</span>
								)}
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
