import type {
	ChatChannel,
	ChatMessageRole,
	ChatMessageStatus,
	CommentAttachment,
	ImageBuildStatus,
} from './common.js';

export enum WsMessageType {
	Connected = 'connected',
	RowChange = 'row_change',
	AgentLifecycle = 'agent_lifecycle',
	ContainerLog = 'container_log',
	ImageBuild = 'image_build',
	RunLog = 'run_log',
	ChatMessageStart = 'chat_message_start',
	ChatMessageDelta = 'chat_message_delta',
	ChatMessageComplete = 'chat_message_complete',
	ChatCompacted = 'chat_compacted',
	ChatConversationUpdated = 'chat_conversation_updated',
	ProjectsChanged = 'projects_changed',
	Error = 'error',
}

export enum WsClientAction {
	Subscribe = 'subscribe',
	Unsubscribe = 'unsubscribe',
}

export type ChangeAction = 'INSERT' | 'UPDATE' | 'DELETE';

export interface WsRowChangeMessage {
	type: WsMessageType.RowChange;
	table: string;
	action: ChangeAction;
	row: Record<string, unknown>;
}

export interface WsAgentLifecycleMessage {
	type: WsMessageType.AgentLifecycle;
	memberId: string;
	status: string;
}

export interface WsConnectedMessage {
	type: WsMessageType.Connected;
}

export interface WsContainerLogMessage {
	type: WsMessageType.ContainerLog;
	projectId: string;
	stream: 'stdout' | 'stderr';
	text: string;
	replace?: boolean;
}

/**
 * Progress of a base-image `docker build`, broadcast to the global
 * `image-builds` room. Keyed by `image` (the build is shared, not per-project)
 * so every project waiting on that image renders the same bar. `percent` is a
 * best-effort estimate from the build's step counter; `label` is the current
 * step's instruction. Terminal `done`/`error` clear the indicator.
 */
export interface WsImageBuildMessage {
	type: WsMessageType.ImageBuild;
	image: string;
	status: ImageBuildStatus;
	percent: number;
	step: number | null;
	totalSteps: number | null;
	label: string | null;
}

export interface WsRunLogMessage {
	type: WsMessageType.RunLog;
	projectId: string;
	runId: string;
	taskId: string | null;
	stream: 'stdout' | 'stderr';
	text: string;
	replace?: boolean;
}

export interface WsErrorMessage {
	type: WsMessageType.Error;
	code: string;
	message: string;
}

/**
 * The instance-wide project index changed (a project was created). Broadcast to
 * the global `projects:global` room with no row payload: the project list is
 * authorized per-caller (`GET /api/projects` filters by team membership), so a
 * full row on a room every client watches would leak projects a user can't see.
 * Clients react by refetching the index, which returns only their visible
 * projects — keeping the project rail live without exposing anything.
 */
export interface WsProjectsChangedMessage {
	type: WsMessageType.ProjectsChanged;
}

/**
 * A new CEO chat message row was created. Sent for assistant replies as they
 * begin streaming AND for user messages from any channel, so every mirrored
 * surface (web, future Telegram/WhatsApp) renders the full thread live.
 */
export interface WsChatMessageStartMessage {
	type: WsMessageType.ChatMessageStart;
	conversationId: string;
	messageId: string;
	role: ChatMessageRole;
	channel: ChatChannel;
	content: string;
	createdAt: string;
	/** Files attached to a user message, so the sent bubble renders chips at once. */
	attachments?: CommentAttachment[];
}

/** Incremental assistant text appended to the bubble keyed by `messageId`. */
export interface WsChatMessageDeltaMessage {
	type: WsMessageType.ChatMessageDelta;
	conversationId: string;
	messageId: string;
	text: string;
}

/** Terminal event for a CEO message: finalizes content, status, and usage. */
export interface WsChatMessageCompleteMessage {
	type: WsMessageType.ChatMessageComplete;
	conversationId: string;
	messageId: string;
	status: ChatMessageStatus;
	content: string;
	inputTokens: number;
	outputTokens: number;
	costCents: number;
}

/**
 * Older messages were compacted into long-term memory and evicted from the
 * active window. Carries no payload beyond the conversation: every mirrored
 * surface reacts by refetching the conversation, which now returns only the
 * retained tail (plus a `compacted_count`), so the chatbox drops the old
 * messages and shows the "chat compacted" marker at the top.
 */
export interface WsChatCompactedMessage {
	type: WsMessageType.ChatCompacted;
	conversationId: string;
}

/**
 * A conversation's title changed (e.g. the CEO auto-titled a previously untitled
 * thread from its content). Every mirrored surface reacts by refetching the thread
 * list so the switcher/rail label updates live, without a reload.
 */
export interface WsChatConversationUpdatedMessage {
	type: WsMessageType.ChatConversationUpdated;
	conversationId: string;
	title: string;
}

/** Any CEO chat WebSocket event, all carrying `conversationId` for thread routing. */
export type WsChatServerMessage =
	| WsChatMessageStartMessage
	| WsChatMessageDeltaMessage
	| WsChatMessageCompleteMessage
	| WsChatCompactedMessage
	| WsChatConversationUpdatedMessage;

export type WsServerMessage =
	| WsRowChangeMessage
	| WsAgentLifecycleMessage
	| WsContainerLogMessage
	| WsImageBuildMessage
	| WsRunLogMessage
	| WsChatMessageStartMessage
	| WsChatMessageDeltaMessage
	| WsChatMessageCompleteMessage
	| WsChatCompactedMessage
	| WsChatConversationUpdatedMessage
	| WsProjectsChangedMessage
	| WsConnectedMessage
	| WsErrorMessage;

export interface WsSubscribeAction {
	action: WsClientAction.Subscribe;
	room: string;
}

export interface WsUnsubscribeAction {
	action: WsClientAction.Unsubscribe;
	room: string;
}

export type WsClientMessage = WsSubscribeAction | WsUnsubscribeAction;
