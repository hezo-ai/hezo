import * as Dialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useGlobalSearch } from '../hooks/use-search';
import { SearchResults } from './search-results';
import { dialogContentClassName, dialogOverlayClassName } from './ui/dialog';
import { Input } from './ui/input';

/**
 * Global command-palette search. Opened from the top-nav search button or the
 * Cmd/Ctrl+K shortcut (wired in `ShellChrome`). Debounced live results from
 * `GET /api/search`, grouped into per-type tabs; selecting a result navigates and
 * closes the palette.
 */
export function GlobalSearchDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [query, setQuery] = useState('');
	const { data, isFetching, enabled } = useGlobalSearch(query);

	// Reopen empty: clear the input whenever the palette closes.
	useEffect(() => {
		if (!open) setQuery('');
	}, [open]);

	const results = data?.results ?? [];

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className={dialogOverlayClassName} />
				<Dialog.Content className={dialogContentClassName.xl} data-testid="global-search-dialog">
					<Dialog.Title className="sr-only">Search</Dialog.Title>
					<Dialog.Description className="sr-only">
						Search tasks, comments, project docs, and skills across your teams.
					</Dialog.Description>
					<Input
						autoFocus
						icon={<Search className="h-4 w-4" />}
						placeholder="Search tasks, comments, docs, skills…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						aria-label="Search"
						data-testid="global-search-input"
					/>
					<div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
						{!enabled && (
							<p className="px-1 py-6 text-center text-[13px] text-text-3">
								Type at least 2 characters to search.
							</p>
						)}
						{enabled && isFetching && results.length === 0 && (
							<p className="px-1 py-6 text-center text-[13px] text-text-3">Searching…</p>
						)}
						{enabled && !isFetching && results.length === 0 && (
							<p
								className="px-1 py-6 text-center text-[13px] text-text-3"
								data-testid="search-empty"
							>
								No results.
							</p>
						)}
						{results.length > 0 && (
							<SearchResults results={results} onSelect={() => onOpenChange(false)} />
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
