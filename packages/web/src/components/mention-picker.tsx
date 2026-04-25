import { AtSign, FileText, Hash, UserRound } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { MentionKind, MentionSearchResult } from '../hooks/use-mentions';

const KIND_ICON: Record<MentionKind, React.ComponentType<{ className?: string }>> = {
	agent: UserRound,
	issue: Hash,
	kb: FileText,
	doc: FileText,
};

const KIND_LABEL: Record<MentionKind, string> = {
	agent: 'Agent',
	issue: 'Issue',
	kb: 'KB doc',
	doc: 'Project doc',
};

interface MentionPickerProps {
	query: string;
	results: MentionSearchResult[];
	loading: boolean;
	highlightedIndex: number;
	onHoverIndex: (index: number) => void;
	onSelect: (result: MentionSearchResult) => void;
}

export function MentionPicker({
	query,
	results,
	loading,
	highlightedIndex,
	onHoverIndex,
	onSelect,
}: MentionPickerProps) {
	const listRef = useRef<HTMLDivElement>(null);

	const grouped = useMemo(() => results, [results]);

	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>(
			`[data-mention-idx="${highlightedIndex}"]`,
		);
		if (el) el.scrollIntoView({ block: 'nearest' });
	}, [highlightedIndex]);

	if (!loading && results.length === 0) {
		return (
			<div className="absolute left-0 right-0 top-full z-40 mt-1 rounded-radius-md border border-border bg-bg-raised shadow-md">
				<div className="px-3 py-2 text-xs text-text-muted">
					{query ? `No matches for @${query}` : 'Type to search'}
				</div>
			</div>
		);
	}

	return (
		<div
			ref={listRef}
			className="absolute left-0 right-0 top-full z-40 mt-1 max-h-64 overflow-y-auto rounded-radius-md border border-border bg-bg-raised shadow-md"
			data-testid="mention-picker"
		>
			{loading && <div className="px-3 py-2 text-xs text-text-muted">Searching…</div>}
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
							isActive ? 'bg-bg-subtle' : ''
						}`}
					>
						<Icon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
						<div className="flex min-w-0 flex-1 flex-col">
							<span className="truncate text-text">{r.label}</span>
							<span className="truncate text-[11px] text-text-subtle">
								{r.kind === 'agent' ? `@${r.handle}` : r.handle}
								{r.sublabel ? ` · ${r.sublabel}` : ''}
							</span>
						</div>
						<span className="ml-2 shrink-0 text-[10px] uppercase tracking-wider text-text-subtle">
							{KIND_LABEL[r.kind]}
						</span>
					</button>
				);
			})}
		</div>
	);
}
