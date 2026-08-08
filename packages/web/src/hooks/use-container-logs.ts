import { type WsContainerLogMessage, WsMessageType, wsRoom } from '@hezo/shared';
import { type LogStreamLine, useLogStream } from './use-log-stream';

export type LogLine = LogStreamLine;

/**
 * One container's log stream.
 *
 * Keyed on the container rather than its project: a project holds as many
 * containers as it has concurrent runs, and a project-keyed room merged their
 * output and served it as whichever container the page was showing.
 */
export function useContainerLogs(containerId: string, phase: string | null) {
	return useLogStream<WsContainerLogMessage>({
		room: phase && containerId ? wsRoom.containerLogs(containerId) : null,
		messageType: WsMessageType.ContainerLog,
		enabled: !!phase && !!containerId,
		extractChunk: (m) =>
			m.containerId === containerId
				? { stream: m.stream, text: m.text, replace: m.replace, trimmed: m.trimmed }
				: null,
	});
}
