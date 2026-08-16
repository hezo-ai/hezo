import type { HeartbeatRunStatus } from '@hezo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { queryKeys } from '../lib/query-keys';
import { useOptimisticMutation } from './use-optimistic-mutation';

export interface ReactionMember {
	id: string;
	slug: string | null;
	display_name: string | null;
}

export interface ReactionGroup {
	kind: string;
	members: ReactionMember[];
	you_reacted: boolean;
}

export interface CommentAttachment {
	id: string;
	content_type: string;
	byte_size: number;
	original_filename: string;
	url: string;
}

export interface Comment {
	id: string;
	/**
	 * Human-friendly per-task slug (creation timestamp, e.g. `20261009112345`)
	 * used for deep-link anchors and `<TASK-ID>#comment-<public_id>` mention
	 * links. `id` (the UUID) stays the key for API calls and parent references.
	 */
	public_id: string;
	task_id: string;
	content_type: string;
	content: string;
	chosen_option: string | null;
	created_at: string;
	author_type: string;
	author_name: string;
	author_member_id: string | null;
	author_api_key_id: string | null;
	/** Signed avatar URL for the author (human user or agent); null → initials. */
	author_icon_url?: string | null;
	author_avatar_spec?: unknown;
	parent_comment_id: string | null;
	/** How the run ended, on a `run` comment. Computed by the route - the stored
	 *  `content` is written at run start and never updated. Null on every other
	 *  comment, and on a run whose row is gone. */
	run_status?: HeartbeatRunStatus | null;
	reactions?: ReactionGroup[];
	attachments?: CommentAttachment[];
}

export function useComments(projectId: string, taskId: string, options?: { enabled?: boolean }) {
	return useQuery({
		queryKey: queryKeys.projects.taskComments(projectId, taskId),
		queryFn: () => api.get<Comment[]>(`/api/projects/${projectId}/tasks/${taskId}/comments`),
		enabled: options?.enabled ?? true,
		staleTime: 0,
	});
}

/**
 * A comment row without its heavy body. The lazy comments feed fetches the whole
 * thread as skeletons up front (so every row can render a placeholder and reserve
 * its space), then loads bodies on demand as rows settle into view. Text comments
 * carry `content: null` + a `text_length` hint; non-text comments keep their small
 * structural `content` + `chosen_option`. Reactions live here (one source of truth).
 */
export interface CommentSkeleton {
	id: string;
	public_id: string;
	task_id: string;
	content_type: string;
	/** Non-text comments carry their small structural payload; text comments are
	 *  null here and load their body via `useCommentBody`. */
	content: unknown | null;
	chosen_option: string | null;
	created_at: string;
	author_type: string | null;
	author_name: string;
	author_member_id: string | null;
	author_api_key_id: string | null;
	/** Signed avatar URL for the author (human user or agent); null → initials. */
	author_icon_url?: string | null;
	author_avatar_spec?: unknown;
	parent_comment_id: string | null;
	/** How the run ended, on a `run` comment. The thread summarizes its collapsed
	 *  groups from these rows, and a folded run row never mounts to fetch its own
	 *  run, so the outcome has to arrive with the skeleton. */
	run_status?: HeartbeatRunStatus | null;
	/** Character length of a text comment's body — sizes its placeholder. Null for non-text. */
	text_length: number | null;
	attachment_count: number;
	reactions?: ReactionGroup[];
}

/** The deferred heavy payload for one comment (loaded on scroll-dwell). */
export interface CommentBody {
	id: string;
	content: unknown;
	attachments?: CommentAttachment[];
}

/** Whether a skeleton row needs a body fetch — text bodies live in the body
 *  payload, and any row with attachments needs their (signed) URLs. Inline-event
 *  rows (system/run) and body-less non-text rows render straight from the skeleton. */
export function skeletonNeedsBody(c: CommentSkeleton): boolean {
	return c.content_type === 'text' || c.attachment_count > 0;
}

/** The skeleton thread — metadata + reactions for every comment, no heavy bodies. */
export function useCommentSkeletons(
	projectId: string,
	taskId: string,
	options?: { enabled?: boolean },
) {
	return useQuery({
		queryKey: queryKeys.projects.taskCommentSkeletons(projectId, taskId),
		queryFn: () =>
			api.get<CommentSkeleton[]>(
				`/api/projects/${projectId}/tasks/${taskId}/comments?view=skeleton`,
			),
		enabled: options?.enabled ?? true,
		staleTime: 0,
	});
}

// --- Batched body loader ------------------------------------------------------
// Body fetches triggered in the same tick (one scroll-settle) coalesce into a
// single `?ids=` request. React Query dedupes per comment id (an id already
// cached or in flight is never re-requested); this batcher dedupes the network.
const MAX_BODY_IDS = 100;

interface PendingBodyBatch {
	ids: string[];
	resolvers: Map<string, { resolve: (b: CommentBody) => void; reject: (e: unknown) => void }>;
	timer: ReturnType<typeof setTimeout> | null;
}
const bodyBatches = new Map<string, PendingBodyBatch>();
const bodyBatchKey = (projectId: string, taskId: string) => `${projectId}::${taskId}`;

function enqueueCommentBody(
	projectId: string,
	taskId: string,
	commentId: string,
): Promise<CommentBody> {
	const key = bodyBatchKey(projectId, taskId);
	let batch = bodyBatches.get(key);
	if (!batch) {
		batch = { ids: [], resolvers: new Map(), timer: null };
		bodyBatches.set(key, batch);
	}
	const b = batch;
	return new Promise<CommentBody>((resolve, reject) => {
		b.resolvers.set(commentId, { resolve, reject });
		b.ids.push(commentId);
		if (!b.timer) b.timer = setTimeout(() => flushBodyBatch(projectId, taskId), 0);
	});
}

async function flushBodyBatch(projectId: string, taskId: string): Promise<void> {
	const key = bodyBatchKey(projectId, taskId);
	const batch = bodyBatches.get(key);
	if (!batch) return;
	bodyBatches.delete(key);
	if (batch.timer) clearTimeout(batch.timer);

	const ids = Array.from(new Set(batch.ids));
	for (let i = 0; i < ids.length; i += MAX_BODY_IDS) {
		const chunk = ids.slice(i, i + MAX_BODY_IDS);
		try {
			const bodies = await api.get<CommentBody[]>(
				`/api/projects/${projectId}/tasks/${taskId}/comments?ids=${chunk.join(',')}`,
			);
			const byId = new Map(bodies.map((body) => [body.id, body]));
			for (const id of chunk) {
				// A comment deleted mid-scroll is absent from the response — settle it
				// as empty so the query doesn't spin; the WS delete drops its row.
				batch.resolvers.get(id)?.resolve(byId.get(id) ?? { id, content: null, attachments: [] });
			}
		} catch (e) {
			for (const id of chunk) batch.resolvers.get(id)?.reject(e);
		}
	}
}

function commentBodyQueryOptions(projectId: string, taskId: string, commentId: string) {
	return {
		queryKey: queryKeys.projects.commentBody(projectId, taskId, commentId),
		queryFn: () => enqueueCommentBody(projectId, taskId, commentId),
		staleTime: Number.POSITIVE_INFINITY,
	};
}

/**
 * Kick off (batched) loads for the comment bodies currently on screen. Called by
 * the feed on scroll-dwell. Dedupes via React Query — an id already cached or in
 * flight is skipped, so calling it every settle is cheap.
 */
export function ensureCommentBodies(projectId: string, taskId: string, commentIds: string[]): void {
	for (const id of commentIds) {
		queryClient.ensureQueryData(commentBodyQueryOptions(projectId, taskId, id)).catch(() => {
			// The failure surfaces on the row's own `useCommentBody` query; a later
			// dwell retries. Nothing to do at the trigger site.
		});
	}
}

/**
 * Read-only subscription to a comment's lazily-loaded body. Never fetches on its
 * own (`enabled: false`) — the feed drives loading via `ensureCommentBodies` on
 * scroll-dwell; this hook just re-renders the row when the body lands in cache.
 */
export function useCommentBody(projectId: string, taskId: string, commentId: string) {
	return useQuery({
		...commentBodyQueryOptions(projectId, taskId, commentId),
		enabled: false,
	});
}

/**
 * Seed the caches after a comment is created so it appears instantly: its body
 * (from the create response) is cached so no fetch fires, and the row is appended
 * to both the full list (intake) and the skeleton list (task feed). Both lists are
 * then invalidated so the server's computed fields (author, public_id) reconcile.
 */
function seedCreatedComment(projectId: string, taskId: string, created: Comment): void {
	const attachments = created.attachments ?? [];
	queryClient.setQueryData<CommentBody>(
		queryKeys.projects.commentBody(projectId, taskId, created.id),
		{ id: created.id, content: created.content, attachments },
	);

	queryClient.setQueryData<Comment[]>(queryKeys.projects.taskComments(projectId, taskId), (old) => {
		if (!old) return old;
		if (old.some((c) => c.id === created.id)) return old;
		return [...old, created];
	});
	queryClient.setQueryData<CommentSkeleton[]>(
		queryKeys.projects.taskCommentSkeletons(projectId, taskId),
		(old) => {
			if (!old) return old;
			if (old.some((c) => c.id === created.id)) return old;
			return [...old, toSkeletonRow(created, attachments.length)];
		},
	);
	queryClient.invalidateQueries({ queryKey: queryKeys.projects.taskComments(projectId, taskId) });
	queryClient.invalidateQueries({
		queryKey: queryKeys.projects.taskCommentSkeletons(projectId, taskId),
	});
}

function toSkeletonRow(created: Comment, attachmentCount: number): CommentSkeleton {
	const isText = created.content_type === 'text';
	const textVal =
		created.content && typeof created.content === 'object'
			? (created.content as { text?: unknown }).text
			: created.content;
	return {
		id: created.id,
		public_id: created.public_id,
		task_id: created.task_id,
		content_type: created.content_type,
		content: isText ? null : (created.content as unknown),
		chosen_option: created.chosen_option,
		created_at: created.created_at,
		author_type: created.author_type ?? null,
		author_name: created.author_name ?? 'Admin',
		author_member_id: created.author_member_id,
		author_api_key_id: created.author_api_key_id,
		// The create response has no signed avatar URL; the invalidate-driven
		// skeleton refetch (below) fills it in, so a new comment briefly shows
		// initials before the author's avatar lands.
		author_icon_url: created.author_icon_url ?? null,
		parent_comment_id: created.parent_comment_id,
		text_length: isText && typeof textVal === 'string' ? textVal.length : null,
		attachment_count: attachmentCount,
		reactions: [],
	};
}

export function useCreateComment(projectId: string, taskId: string) {
	return useMutation({
		mutationFn: (data: {
			content: string;
			content_type?: string;
			effort?: string;
			parent_comment_id?: string;
			attachment_ids?: string[];
		}) => api.post<Comment>(`/api/projects/${projectId}/tasks/${taskId}/comments`, data),
		onSuccess: (created) => seedCreatedComment(projectId, taskId, created),
	});
}

/**
 * Create a comment on a task chosen at call time (e.g. the action-review
 * "Add to task" picker). Same cache handling as `useCreateComment`, but the
 * target task travels in the mutation variables instead of the hook args.
 */
export function useCreateCommentOnTask(projectId: string) {
	return useMutation({
		mutationFn: ({ taskId, content }: { taskId: string; content: string }) =>
			api.post<Comment>(`/api/projects/${projectId}/tasks/${taskId}/comments`, { content }),
		onSuccess: (created, { taskId }) => seedCreatedComment(projectId, taskId, created),
	});
}

export interface ReactionMutationResponse {
	comment_id: string;
	kind: string;
	reactions: ReactionGroup[];
}

const OPTIMISTIC_MEMBER: ReactionMember = {
	id: '__optimistic__',
	slug: null,
	display_name: 'You',
};

function predictAddReaction(reactions: ReactionGroup[] | undefined, kind: string): ReactionGroup[] {
	const groups = reactions ?? [];
	const existing = groups.find((g) => g.kind === kind);
	if (existing?.you_reacted) return groups;
	if (existing) {
		return groups.map((g) =>
			g.kind === kind ? { ...g, you_reacted: true, members: [...g.members, OPTIMISTIC_MEMBER] } : g,
		);
	}
	return [...groups, { kind, members: [OPTIMISTIC_MEMBER], you_reacted: true }];
}

function predictRemoveReaction(
	reactions: ReactionGroup[] | undefined,
	kind: string,
): ReactionGroup[] {
	const groups = reactions ?? [];
	const existing = groups.find((g) => g.kind === kind);
	if (!existing?.you_reacted) return groups;
	return groups
		.map((g) => {
			if (g.kind !== kind) return g;
			const removedIdx = g.members.findIndex((m) => m.id === OPTIMISTIC_MEMBER.id);
			const members =
				removedIdx >= 0
					? [...g.members.slice(0, removedIdx), ...g.members.slice(removedIdx + 1)]
					: g.members.slice(0, -1);
			return { ...g, you_reacted: false, members };
		})
		.filter((g) => g.members.length > 0);
}

function applyToComment<T extends { id: string; reactions?: ReactionGroup[] }>(
	current: T[] | undefined,
	commentId: string,
	update: (c: T) => T,
): T[] | undefined {
	if (!current) return current;
	return current.map((c) => (c.id === commentId ? update(c) : c));
}

// Reactions live on the skeleton row (the feed's single source of truth), so the
// optimistic reaction mutations target the skeleton cache, not the full list.
export function useAddReaction(projectId: string, taskId: string) {
	return useOptimisticMutation<
		{ commentId: string; kind: string },
		ReactionMutationResponse,
		CommentSkeleton[]
	>({
		mutationFn: ({ commentId, kind }) =>
			api.put<ReactionMutationResponse>(
				`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}/reactions/${kind}`,
				{},
			),
		queryKey: queryKeys.projects.taskCommentSkeletons(projectId, taskId),
		applyOptimistic: (current, { commentId, kind }) =>
			applyToComment(current, commentId, (c) => ({
				...c,
				reactions: predictAddReaction(c.reactions, kind),
			})),
		mergeResponse: (current, updated) =>
			applyToComment(current, updated.comment_id, (c) => ({ ...c, reactions: updated.reactions })),
		errorMessage: 'Failed to add reaction',
	});
}

export function useRemoveReaction(projectId: string, taskId: string) {
	return useOptimisticMutation<
		{ commentId: string; kind: string },
		ReactionMutationResponse,
		CommentSkeleton[]
	>({
		mutationFn: ({ commentId, kind }) =>
			api.delete<ReactionMutationResponse>(
				`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}/reactions/${kind}`,
			),
		queryKey: queryKeys.projects.taskCommentSkeletons(projectId, taskId),
		applyOptimistic: (current, { commentId, kind }) =>
			applyToComment(current, commentId, (c) => ({
				...c,
				reactions: predictRemoveReaction(c.reactions, kind),
			})),
		mergeResponse: (current, updated) =>
			applyToComment(current, updated.comment_id, (c) => ({ ...c, reactions: updated.reactions })),
		errorMessage: 'Failed to remove reaction',
	});
}

/**
 * Approve or deny an agent-filed asset deletion request. Response-driven —
 * never optimistic: approval permanently deletes assets server-side, so the
 * card must only flip once the server confirms. Refreshes the thread, the
 * assets library, and the inbox badge (the request's mentions are marked read).
 */
export function useResolveAssetDeletion(projectId: string, taskId: string) {
	return useMutation({
		mutationFn: ({ commentId, approve }: { commentId: string; approve: boolean }) =>
			api.post(
				`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}/resolve-asset-deletion`,
				{ approve },
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskCommentSkeletons(projectId, taskId),
			});
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskComments(projectId, taskId),
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.assets(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.inboxCount(projectId) });
			queryClient.invalidateQueries({ queryKey: queryKeys.projects.inboxMentions(projectId) });
		},
	});
}

export function useFulfillCredential(projectId: string, taskId: string) {
	return useMutation({
		mutationFn: ({
			commentId,
			value,
			confirmed,
			allowedHosts,
			allowBodySubstitution,
		}: {
			commentId: string;
			value?: string;
			confirmed?: boolean;
			allowedHosts?: string[];
			allowBodySubstitution?: boolean;
		}) =>
			api.post(
				`/api/projects/${projectId}/tasks/${taskId}/comments/${commentId}/fulfill-credential`,
				{
					value,
					confirmed,
					allowed_hosts: allowedHosts,
					allow_body_substitution: allowBodySubstitution,
				},
			),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskCommentSkeletons(projectId, taskId),
			});
			queryClient.invalidateQueries({
				queryKey: queryKeys.projects.taskComments(projectId, taskId),
			});
		},
	});
}
