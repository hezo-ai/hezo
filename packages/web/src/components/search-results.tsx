import { HIGHLIGHT_SENTINEL, type SearchResult, type SearchResultType } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import { BookOpen, CheckSquare, FileText, type LucideIcon, MessageSquare } from 'lucide-react';
import { Fragment, type ReactNode, useMemo, useState } from 'react';
import { Tabs } from './ui/tabs';

const TYPE_META: Record<SearchResultType, { label: string; Icon: LucideIcon }> = {
	task: { label: 'Tasks', Icon: CheckSquare },
	comment: { label: 'Comments', Icon: MessageSquare },
	project_doc: { label: 'Docs', Icon: FileText },
	skill: { label: 'Skills', Icon: BookOpen },
};

// Tab order — task-centric first, skills (instance-global) last.
const TYPE_ORDER: SearchResultType[] = ['task', 'comment', 'project_doc', 'skill'];

/**
 * Results for the global search palette, split into one tab per result type with
 * a count (e.g. `Comments (3)`), so it's immediately clear how many of each kind
 * matched. The active tab shows that type's hits; clicking a row navigates (via a
 * real `<Link>`) and calls `onSelect` to close the palette.
 */
export function SearchResults({
	results,
	onSelect,
}: {
	results: SearchResult[];
	onSelect: () => void;
}) {
	const grouped = useMemo(() => {
		const g: Record<SearchResultType, SearchResult[]> = {
			task: [],
			comment: [],
			project_doc: [],
			skill: [],
		};
		for (const r of results) g[r.type].push(r);
		return g;
	}, [results]);

	const tabs = TYPE_ORDER.filter((t) => grouped[t].length > 0);
	const [activeType, setActiveType] = useState<SearchResultType | null>(null);
	// Default to the first non-empty tab; fall back if the active one disappears
	// after a new query.
	const active = activeType && tabs.includes(activeType) ? activeType : (tabs[0] ?? null);

	if (!active) return null;

	return (
		<div className="flex min-h-0 flex-col">
			<Tabs
				items={tabs.map((t) => {
					const { label, Icon } = TYPE_META[t];
					return {
						key: t,
						label,
						icon: <Icon className="h-3.5 w-3.5" />,
						count: grouped[t].length,
						testId: `search-tab-${t}`,
					};
				})}
				value={active}
				onValueChange={(k) => setActiveType(k as SearchResultType)}
				activeSurface="bg-surface"
			/>
			<ul className="flex flex-col overflow-y-auto py-1" data-testid="search-results-list">
				{grouped[active].map((r) => (
					<li key={`${r.type}-${r.id}`}>
						<SearchResultRow result={r} onSelect={onSelect} />
					</li>
				))}
			</ul>
		</div>
	);
}

const ROW_CLASS = 'mx-1 flex items-start gap-2 rounded-md px-3 py-2 hover:bg-surface-2';

/**
 * Render a snippet whose matched terms the server wrapped in
 * {@link HIGHLIGHT_SENTINEL}. Splitting on the sentinel and rendering each segment
 * as a React text node keeps this XSS-safe — content is never interpreted as HTML
 * (no `dangerouslySetInnerHTML`). Odd segments are the matched spans.
 */
function renderHighlighted(snippet: string): ReactNode {
	if (!snippet.includes(HIGHLIGHT_SENTINEL)) return snippet;
	return snippet.split(HIGHLIGHT_SENTINEL).map((segment, i) =>
		i % 2 === 1 ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and stable per render
			<mark key={i} className="rounded-sm bg-accent/20 px-0.5 text-text-1">
				{segment}
			</mark>
		) : (
			// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and stable per render
			<Fragment key={i}>{segment}</Fragment>
		),
	);
}

function SearchResultRow({ result, onSelect }: { result: SearchResult; onSelect: () => void }) {
	const { Icon } = TYPE_META[result.type];
	const testId = `search-result-${result.type}`;
	const body = (
		<>
			<Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />
			<span className="flex min-w-0 flex-col">
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="truncate text-[13px] text-text-1">{result.title}</span>
				</span>
				{result.snippet && (
					<span className="line-clamp-2 text-xs text-text-3">
						{renderHighlighted(result.snippet)}
					</span>
				)}
			</span>
		</>
	);

	if (result.type === 'task' || result.type === 'comment') {
		return (
			<Link
				to="/projects/$projectId/tasks/$taskId"
				params={{
					projectId: result.projectSlug ?? '',
					taskId: (result.taskIdentifier ?? '').toLowerCase(),
				}}
				hash={result.commentPublicId ? `comment-${result.commentPublicId}` : undefined}
				onClick={onSelect}
				className={ROW_CLASS}
				data-testid={testId}
			>
				{body}
			</Link>
		);
	}

	if (result.type === 'project_doc') {
		return (
			<Link
				to="/projects/$projectId/documents"
				params={{ projectId: result.projectSlug ?? '' }}
				search={{ file: result.docSlug }}
				onClick={onSelect}
				className={ROW_CLASS}
				data-testid={testId}
			>
				{body}
			</Link>
		);
	}

	return (
		<Link to="/settings/skills" onClick={onSelect} className={ROW_CLASS} data-testid={testId}>
			{body}
		</Link>
	);
}
