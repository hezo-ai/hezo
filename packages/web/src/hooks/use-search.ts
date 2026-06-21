import type { SearchResult, SearchScope } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

interface SearchResponse {
	results: SearchResult[];
	/** Present (with empty results) while the embedding model is still loading. */
	message?: string;
}

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 150;

/**
 * Live global search for the Cmd/Ctrl+K palette. Debounces the raw input, then
 * queries `GET /api/search` (cross-team, scoped server-side to the caller's
 * teams). Returns the React Query result plus the debounced query so the UI can
 * tell "still typing" from "no matches".
 */
export function useGlobalSearch(query: string, scope: SearchScope = 'all') {
	const [debounced, setDebounced] = useState(query);

	useEffect(() => {
		const id = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
		return () => clearTimeout(id);
	}, [query]);

	const trimmed = debounced.trim();
	const enabled = trimmed.length >= MIN_QUERY_LENGTH;

	const result = useQuery({
		queryKey: queryKeys.search(trimmed, scope),
		queryFn: () => api.get<SearchResponse>('/api/search', { q: trimmed, scope, limit: '20' }),
		enabled,
		staleTime: 30_000,
	});

	return { ...result, enabled, debouncedQuery: trimmed };
}
