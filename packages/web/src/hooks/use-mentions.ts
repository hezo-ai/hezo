import { extractBacktickedMentionCandidates, extractMentionCandidates } from '@hezo/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';
import { queryKeys } from '../lib/query-keys';

export interface DocMentionsRequest {
	kbSlugs: string[];
	projectDocs: Array<{ project_slug: string; filename: string }>;
	assets: Array<{ project_slug: string; filename: string }>;
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

export interface ResolvedAsset {
	project_slug: string;
	filename: string;
	id: string;
	content_type: string;
	signed_url: string;
}

interface DocMentionsResponse {
	kb_docs: ResolvedKbDoc[];
	project_docs: ResolvedProjectDoc[];
	assets: ResolvedAsset[];
}

export function useDocMentions(projectId: string, candidates: DocMentionsRequest) {
	const key = useMemo(() => {
		const kbSlugs = [...new Set(candidates.kbSlugs.map((s) => s.toLowerCase()))].sort();
		const projectDocs = [
			...new Set(
				candidates.projectDocs.map(
					(d) => `${d.project_slug.toLowerCase()}/${d.filename.toLowerCase()}`,
				),
			),
		].sort();
		const assets = [
			...new Set(
				candidates.assets.map((a) => `${a.project_slug.toLowerCase()}/${a.filename.toLowerCase()}`),
			),
		].sort();
		return { kbSlugs, projectDocs, assets };
	}, [candidates]);

	return useQuery({
		queryKey: queryKeys.projects.docsResolve(projectId, key),
		queryFn: () =>
			api.post<DocMentionsResponse>(`/api/projects/${projectId}/docs/resolve`, {
				kb_slugs: key.kbSlugs,
				project_docs: candidates.projectDocs.map((d) => ({
					project_slug: d.project_slug.toLowerCase(),
					filename: d.filename,
				})),
				assets: candidates.assets.map((a) => ({
					project_slug: a.project_slug.toLowerCase(),
					filename: a.filename,
				})),
			}),
		enabled:
			!!projectId &&
			(key.kbSlugs.length > 0 || key.projectDocs.length > 0 || key.assets.length > 0),
		staleTime: 60_000,
	});
}

export interface InstanceResolvedTask {
	identifier: string;
	title: string;
	project_slug: string;
	status: string;
}

export interface InstanceResolvedAgent {
	slug: string;
	title: string;
	human_name?: string | null;
	role_description?: string | null;
	project_slug: string;
}

export interface InstanceMentionsResponse {
	tasks: InstanceResolvedTask[];
	kb_docs: ResolvedKbDoc[];
	project_docs: ResolvedProjectDoc[];
	assets: ResolvedAsset[];
	agents: InstanceResolvedAgent[];
}

/**
 * Instance-wide mention resolution for the global CEO chat. Candidates are
 * extracted from the message content client-side; the server resolves only
 * references that are unique across the whole instance (ambiguous ones stay
 * plain text). The sorted-array key dedupes identical candidate sets across
 * messages and bounds refetches while a reply streams.
 */
export function useInstanceMentions(content: string, enabled: boolean) {
	const key = useMemo(() => {
		const c = extractMentionCandidates(content);
		// CEO replies are LLM-authored and routinely backtick filenames; the chat
		// linkifies backticked doc/asset references (see remark-mentions), so resolve
		// those too. Only docs/assets are merged — backticked tasks/@-mentions stay
		// inert, so their candidates are deliberately left out.
		const coded = extractBacktickedMentionCandidates(content);
		return {
			tasks: [...c.tasks].sort(),
			filenames: [...new Set([...c.filenames, ...coded.filenames])].sort(),
			assets: [...new Set([...c.assets, ...coded.assets])].sort(),
			agents: [...c.agents].sort(),
		};
	}, [content]);

	const hasCandidates =
		key.tasks.length + key.filenames.length + key.assets.length + key.agents.length > 0;

	return useQuery({
		queryKey: queryKeys.instanceMentionsResolve(key),
		queryFn: () => api.post<InstanceMentionsResponse>('/api/mentions/resolve', key),
		enabled: enabled && hasCandidates,
		staleTime: 60_000,
	});
}

export type MentionKind = 'agent' | 'task' | 'kb' | 'doc';

export interface MentionSearchResult {
	kind: MentionKind;
	handle: string;
	label: string;
	sublabel?: string;
}

export function useMentionSearch(
	projectId: string,
	q: string,
	options?: { projectSlug?: string; enabled?: boolean },
) {
	const projectSlug = options?.projectSlug;
	const enabled = options?.enabled ?? true;
	return useQuery({
		queryKey: queryKeys.projects.mentionsSearch(projectId, q, projectSlug ?? null),
		queryFn: () => {
			const params: Record<string, string> = { q };
			if (projectSlug) params.project_slug = projectSlug;
			return api.get<MentionSearchResult[]>(`/api/projects/${projectId}/mentions/search`, params);
		},
		enabled: enabled && !!projectId,
		staleTime: 30_000,
	});
}
