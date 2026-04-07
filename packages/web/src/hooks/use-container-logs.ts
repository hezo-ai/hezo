import { type WsContainerLogMessage, WsMessageType } from '@hezo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from '../contexts/socket-context';

export interface LogLine {
	id: number;
	stream: 'stdout' | 'stderr';
	text: string;
}

const MAX_LINES = 5000;
let nextLogId = 0;

export function useContainerLogs(projectId: string, enabled: boolean) {
	const [logs, setLogs] = useState<LogLine[]>([]);
	const logsRef = useRef<LogLine[]>([]);
	const { joinRoom, leaveRoom, subscribe } = useSocket();

	useEffect(() => {
		if (!enabled) return;

		const room = `container-logs:${projectId}`;
		joinRoom(room);

		const unsubscribe = subscribe(WsMessageType.ContainerLog, (msg) => {
			const { stream, text } = msg as WsContainerLogMessage;
			if ((msg as WsContainerLogMessage).projectId !== projectId) return;

			const lines = text.split('\n').filter((l) => l.length > 0);
			const newEntries = lines.map((l) => ({ id: nextLogId++, stream, text: l }));

			logsRef.current = [...logsRef.current, ...newEntries].slice(-MAX_LINES);
			setLogs(logsRef.current);
		});

		return () => {
			unsubscribe();
			leaveRoom(room);
		};
	}, [projectId, enabled, joinRoom, leaveRoom, subscribe]);

	const clear = useCallback(() => {
		logsRef.current = [];
		setLogs([]);
	}, []);

	return { logs, clear };
}
