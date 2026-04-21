export enum WsMessageType {
	Connected = 'connected',
	RowChange = 'row_change',
	AgentLifecycle = 'agent_lifecycle',
	ContainerLog = 'container_log',
	RunLog = 'run_log',
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
}

export interface WsRunLogMessage {
	type: WsMessageType.RunLog;
	projectId: string;
	runId: string;
	issueId: string | null;
	stream: 'stdout' | 'stderr';
	text: string;
}

export interface WsErrorMessage {
	type: WsMessageType.Error;
	code: string;
	message: string;
}

export type WsServerMessage =
	| WsRowChangeMessage
	| WsAgentLifecycleMessage
	| WsContainerLogMessage
	| WsRunLogMessage
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
