import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';

export interface DocMentionsRequest {
	kbSlugs: string[];
	projectDocs: Array<{ project_slug: string; filename: string }>;
}

export interface ResolvedKbDoc {
	slug: string;
	title: string;
	size: number;
	updated_at: string;
}

export interface ResolvedProjectDoc {
	project_slug: string;
	filename: string;
	size: number;
	updated_at: string;
}

interface DocMentionsResponse {
	kb_docs: ResolvedKbDoc[];
	project_docs: ResolvedProjectDoc[];
}

export function useDocMentions(companyId: string, candidates: DocMentionsRequest) {
	const key = useMemo(() => {
		const kbSlugs = [...new Set(candidates.kbSlugs.map((s) => s.toLowerCase()))].sort();
		const projectDocs = [
			...new Set(
				candidates.projectDocs.map(
					(d) => `${d.project_slug.toLowerCase()}/${d.filename.toLowerCase()}`,
				),
			),
		].sort();
		return { kbSlugs, projectDocs };
	}, [candidates]);

	return useQuery({
		queryKey: ['companies', companyId, 'docs', 'resolve', key],
		queryFn: () =>
			api.post<DocMentionsResponse>(`/api/companies/${companyId}/docs/resolve`, {
				kb_slugs: key.kbSlugs,
				project_docs: candidates.projectDocs.map((d) => ({
					project_slug: d.project_slug.toLowerCase(),
					filename: d.filename,
				})),
			}),
		enabled: !!companyId && (key.kbSlugs.length > 0 || key.projectDocs.length > 0),
		staleTime: 60_000,
	});
}

export type MentionKind = 'agent' | 'issue' | 'kb' | 'doc';

export interface MentionSearchResult {
	kind: MentionKind;
	handle: string;
	label: string;
	sublabel?: string;
}

export function useMentionSearch(
	companyId: string,
	q: string,
	options?: { projectSlug?: string; enabled?: boolean },
) {
	const projectSlug = options?.projectSlug;
	const enabled = options?.enabled ?? true;
	return useQuery({
		queryKey: ['companies', companyId, 'mentions', 'search', q, projectSlug ?? null],
		queryFn: () => {
			const params: Record<string, string> = { q };
			if (projectSlug) params.project_slug = projectSlug;
			return api.get<MentionSearchResult[]>(`/api/companies/${companyId}/mentions/search`, params);
		},
		enabled: enabled && !!companyId,
		staleTime: 30_000,
	});
}
