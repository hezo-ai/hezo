import type { CeoChannel, CeoMessageRole, CeoMessageStatus, ImageBuildStatus } from './common.js';

export enum WsMessageType {
	Connected = 'connected',
	RowChange = 'row_change',
	AgentLifecycle = 'agent_lifecycle',
	ContainerLog = 'container_log',
	ImageBuild = 'image_build',
	RunLog = 'run_log',
	CeoMessageStart = 'ceo_message_start',
	CeoMessageDelta = 'ceo_message_delta',
	CeoMessageComplete = 'ceo_message_complete',
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
 * A new CEO chat message row was created. Sent for assistant replies as they
 * begin streaming AND for user messages from any channel, so every mirrored
 * surface (web, future Telegram/WhatsApp) renders the full thread live.
 */
export interface WsCeoMessageStartMessage {
	type: WsMessageType.CeoMessageStart;
	messageId: string;
	role: CeoMessageRole;
	channel: CeoChannel;
	content: string;
	createdAt: string;
}

/** Incremental assistant text appended to the bubble keyed by `messageId`. */
export interface WsCeoMessageDeltaMessage {
	type: WsMessageType.CeoMessageDelta;
	messageId: string;
	text: string;
}

/** Terminal event for a CEO message: finalizes content, status, and usage. */
export interface WsCeoMessageCompleteMessage {
	type: WsMessageType.CeoMessageComplete;
	messageId: string;
	status: CeoMessageStatus;
	content: string;
	inputTokens: number;
	outputTokens: number;
	costCents: number;
}

export type WsServerMessage =
	| WsRowChangeMessage
	| WsAgentLifecycleMessage
	| WsContainerLogMessage
	| WsImageBuildMessage
	| WsRunLogMessage
	| WsCeoMessageStartMessage
	| WsCeoMessageDeltaMessage
	| WsCeoMessageCompleteMessage
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
