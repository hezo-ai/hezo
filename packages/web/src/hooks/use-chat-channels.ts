import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { toast } from './use-toast';

export interface ChatChannelConfigView {
	channel: string;
	enabled: boolean;
	has_token: boolean;
	/** Whether a secondary app-level token is stored (Slack Socket Mode). */
	has_app_token: boolean;
	has_webhook: boolean;
	metadata: Record<string, unknown>;
	updated_at: string;
}

/** Save-time credential check result (returned when enabling a channel). */
export interface ChannelValidation {
	ok: boolean;
	errors: string[];
}

export interface SaveChannelResult {
	channel: string;
	enabled: boolean;
	has_token: boolean;
	has_app_token: boolean;
	validation?: ChannelValidation;
}

export interface ChatIdentityLink {
	id: string;
	channel: string;
	external_user_id: string;
	external_handle: string | null;
	user_id: string;
	display_name: string;
	created_at: string;
}

const channelsKey = () => ['chat', 'channels'] as const;
const identitiesKey = () => ['chat', 'identities'] as const;

/** Channel bot configs (token/secret redacted) for the settings page. */
export function useChatChannels() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: channelsKey(),
		queryFn: () => api.get<{ channels: ChatChannelConfigView[] }>('/api/chat/channels'),
	});
	const save = useMutation({
		mutationFn: (input: {
			channel: string;
			enabled: boolean;
			bot_token?: string;
			app_token?: string;
			metadata?: Record<string, unknown>;
		}) =>
			api.put<SaveChannelResult>(`/api/chat/channels/${input.channel}`, {
				enabled: input.enabled,
				bot_token: input.bot_token,
				app_token: input.app_token,
				metadata: input.metadata,
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: channelsKey() }),
		onError: (e: { message?: string }) => toast.error(e?.message ?? 'Failed to save channel'),
	});
	return {
		channels: query.data?.channels ?? [],
		loaded: !query.isPending,
		saveChannel: save.mutateAsync,
		saving: save.isPending,
	};
}

/** Identity allowlist links for the settings page. */
export function useChatIdentities() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: identitiesKey(),
		queryFn: () => api.get<{ identities: ChatIdentityLink[] }>('/api/chat/identities'),
	});
	const link = useMutation({
		mutationFn: (input: {
			channel: string;
			external_user_id: string;
			user_id: string;
			external_handle?: string;
		}) => api.post('/api/chat/identities', input),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: identitiesKey() }),
		onError: (e: { message?: string }) => toast.error(e?.message ?? 'Failed to link identity'),
	});
	const unlink = useMutation({
		mutationFn: (id: string) => api.delete(`/api/chat/identities/${id}`),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: identitiesKey() }),
		onError: (e: { message?: string }) => toast.error(e?.message ?? 'Failed to unlink identity'),
	});
	return {
		identities: query.data?.identities ?? [],
		loaded: !query.isPending,
		linkIdentity: link.mutateAsync,
		unlinkIdentity: unlink.mutateAsync,
	};
}
