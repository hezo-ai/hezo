import { AtSign, Braces, FileText, Hash, UserRound } from 'lucide-react';
import { type RefObject, useEffect, useMemo } from 'react';
import type { MentionKind, MentionSearchResult } from '../hooks/use-mentions';
import { usePanelPlacement } from '../hooks/use-panel-placement';

const KIND_ICON: Record<MentionKind, React.ComponentType<{ className?: string }>> = {
	agent: UserRound,
	task: Hash,
	kb: FileText,
	doc: FileText,
	variable: Braces,
};

const KIND_LABEL: Record<MentionKind, string> = {
	agent: 'Agent',
	task: 'Task',
	kb: 'KB doc',
	doc: 'Project doc',
	variable: 'Variable',
};

/** Everything but the vertical side, which `usePanelPlacement` decides per open. */
const PANEL_BASE =
	'absolute left-0 right-0 z-40 rounded-md border border-border bg-surface shadow-md';

/** The former `max-h-64`, now the design cap the placement clamp works against. */
const PANEL_MAX_HEIGHT_PX = 256;

interface MentionPickerProps {
	query: string;
	results: MentionSearchResult[];
	loading: boolean;
	highlightedIndex: number;
	onHoverIndex: (index: number) => void;
	onSelect: (result: MentionSearchResult) => void;
	/** The textarea's positioning wrapper — what the picker is measured against. */
	anchorRef: RefObject<HTMLElement | null>;
	/** The characters that opened the picker, echoed in the no-matches line. */
	trigger?: string;
}

export function MentionPicker({
	query,
	results,
	loading,
	highlightedIndex,
	onHoverIndex,
	onSelect,
	anchorRef,
	trigger = '@',
}: MentionPickerProps) {
	// The picker only mounts while open, so `open` is unconditionally true here.
	// One ref serves both jobs: the panel is the scroll container, so it is what
	// gets measured and what the highlighted row scrolls within.
	const { panelRef, side, sideClassName, style } = usePanelPlacement<HTMLDivElement>(anchorRef, {
		open: true,
		preferredMaxHeight: PANEL_MAX_HEIGHT_PX,
		deps: [results, loading, query],
	});

	const grouped = useMemo(() => results, [results]);

	useEffect(() => {
		const el = panelRef.current?.querySelector<HTMLElement>(
			`[data-mention-idx="${highlightedIndex}"]`,
		);
		if (el) el.scrollIntoView({ block: 'nearest' });
	}, [highlightedIndex, panelRef]);

	if (!loading && results.length === 0) {
		return (
			<div
				ref={panelRef}
				className={`${PANEL_BASE} ${sideClassName}`}
				style={style}
				data-placement={side}
			>
				<div className="px-3 py-2 text-xs text-text-2">
					{query ? `No matches for ${trigger}${query}` : 'Type to search'}
				</div>
			</div>
		);
	}

	return (
		<div
			ref={panelRef}
			className={`${PANEL_BASE} ${sideClassName} overflow-y-auto`}
			style={style}
			data-placement={side}
			data-testid="mention-picker"
		>
			{loading && <div className="px-3 py-2 text-xs text-text-2">Searching…</div>}
			{grouped.map((r, idx) => {
				const Icon = KIND_ICON[r.kind] ?? AtSign;
				const isActive = idx === highlightedIndex;
				return (
					<button
						key={`${r.kind}:${r.handle}`}
						type="button"
						data-mention-idx={idx}
						data-testid={`mention-option-${r.kind}`}
						onMouseDown={(e) => {
							e.preventDefault();
							onSelect(r);
						}}
						onMouseEnter={() => onHoverIndex(idx)}
						className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${
							isActive ? 'bg-surface-2' : ''
						}`}
					>
						<Icon className="h-3.5 w-3.5 shrink-0 text-text-2" />
						<div className="flex min-w-0 flex-1 flex-col">
							<span className="truncate text-text-1">{r.label}</span>
							<span className="truncate text-[11px] text-text-3">
								{/* A variable's handle IS its label, so repeating it here would
								    print the token twice; its description stands alone. */}
								{r.kind === 'variable' ? (r.sublabel ?? '') : null}
								{r.kind !== 'variable' && (r.kind === 'agent' ? `@${r.handle}` : r.handle)}
								{r.kind !== 'variable' && r.sublabel ? ` · ${r.sublabel}` : ''}
							</span>
						</div>
						<span className="ml-2 shrink-0 text-[10px] uppercase tracking-wider text-text-3">
							{KIND_LABEL[r.kind]}
						</span>
					</button>
				);
			})}
		</div>
	);
}
