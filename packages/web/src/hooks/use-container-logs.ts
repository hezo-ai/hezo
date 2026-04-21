import { type WsContainerLogMessage, WsMessageType } from '@hezo/shared';
import { type LogStreamLine, useLogStream } from './use-log-stream';

export type LogLine = LogStreamLine;

export function useContainerLogs(projectId: string, phase: string | null) {
	return useLogStream<WsContainerLogMessage>({
		room: phase && projectId ? `container-logs:${projectId}` : null,
		messageType: WsMessageType.ContainerLog,
		enabled: !!phase && !!projectId,
		extractChunk: (m) => (m.projectId === projectId ? { stream: m.stream, text: m.text } : null),
	});
}
