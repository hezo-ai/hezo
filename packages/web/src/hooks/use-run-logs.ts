import { WsMessageType, type WsRunLogMessage } from '@hezo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from '../contexts/socket-context';

export interface RunLogLine {
	id: number;
	stream: 'stdout' | 'stderr';
	text: string;
}

const MAX_LINES = 5000;
let nextId = 0;

export function useRunLogs(
	projectId: string | null | undefined,
	runId: string | null | undefined,
	seedText?: string | null,
	isActive = false,
) {
	const [lines, setLines] = useState<RunLogLine[]>([]);
	const linesRef = useRef<RunLogLine[]>([]);
	const { joinRoom, leaveRoom, subscribe } = useSocket();

	useEffect(() => {
		const seeded: RunLogLine[] = [];
		if (seedText) {
			for (const raw of seedText.split('\n')) {
				if (raw.length === 0) continue;
				const isStderr = raw.startsWith('[stderr] ');
				seeded.push({
					id: nextId++,
					stream: isStderr ? 'stderr' : 'stdout',
					text: isStderr ? raw.slice('[stderr] '.length) : raw,
				});
			}
		}
		linesRef.current = seeded;
		setLines(seeded);
	}, [seedText]);

	useEffect(() => {
		if (!projectId || !runId || !isActive) return;

		const room = `project-runs:${projectId}`;
		joinRoom(room);

		const unsubscribe = subscribe(WsMessageType.RunLog, (msg) => {
			const m = msg as WsRunLogMessage;
			if (m.projectId !== projectId || m.runId !== runId) return;
			const newEntries = m.text
				.split('\n')
				.filter((t) => t.length > 0)
				.map((text) => ({ id: nextId++, stream: m.stream, text }));
			if (newEntries.length === 0) return;
			linesRef.current = [...linesRef.current, ...newEntries].slice(-MAX_LINES);
			setLines(linesRef.current);
		});

		return () => {
			unsubscribe();
			leaveRoom(room);
		};
	}, [projectId, runId, isActive, joinRoom, leaveRoom, subscribe]);

	const clear = useCallback(() => {
		linesRef.current = [];
		setLines([]);
	}, []);

	return { lines, clear };
}
