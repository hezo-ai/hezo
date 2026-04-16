import { WsMessageType, type WsRunLogMessage } from '@hezo/shared';
import { type LogStreamLine, useLogStream } from './use-log-stream';

export type RunLogLine = LogStreamLine;

export function useRunLogs(
	projectId: string | null | undefined,
	runId: string | null | undefined,
	seedText?: string | null,
	isActive = false,
) {
	return useLogStream<WsRunLogMessage>({
		room: projectId && runId ? `project-runs:${projectId}` : null,
		messageType: WsMessageType.RunLog,
		enabled: isActive,
		seedText,
		extractChunk: (m) =>
			m.projectId === projectId && m.runId === runId ? { stream: m.stream, text: m.text } : null,
	});
}
