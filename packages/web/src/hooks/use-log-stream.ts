import type { WsMessageType, WsServerMessage } from '@hezo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSocket } from '../contexts/socket-context';

export interface LogStreamLine {
	id: number;
	stream: 'stdout' | 'stderr';
	text: string;
}

export interface LogChunk {
	stream: 'stdout' | 'stderr';
	text: string;
}

const DEFAULT_MAX_LINES = 5000;
let nextLineId = 0;

function nextId(): number {
	return nextLineId++;
}

/**
 * Parse a stored log_text snapshot back into structured lines. Lines prefixed
 * with `[stderr] ` are tagged as stderr; everything else is stdout.
 */
export function parseSeedLogText(seed: string | null | undefined): LogStreamLine[] {
	if (!seed) return [];
	const out: LogStreamLine[] = [];
	for (const raw of seed.split('\n')) {
		if (raw.length === 0) continue;
		const isStderr = raw.startsWith('[stderr] ');
		out.push({
			id: nextId(),
			stream: isStderr ? 'stderr' : 'stdout',
			text: isStderr ? raw.slice('[stderr] '.length) : raw,
		});
	}
	return out;
}

export interface UseLogStreamOptions<M extends WsServerMessage> {
	room: string | null;
	messageType: WsMessageType;
	enabled: boolean;
	extractChunk: (msg: M) => LogChunk | null;
	seedText?: string | null;
	maxLines?: number;
}

/**
 * Generic hook for streaming log lines from a WebSocket room. Maintains a
 * capped, ref-backed buffer and exposes `{ lines, clear }`. The caller decides
 * which messages to accept via `extractChunk`, which receives each WS message
 * of the given type and returns either a `LogChunk` or `null` to skip.
 *
 * The buffer is reset whenever `room` or `seedText` changes, so callers should
 * pass a `room` that uniquely identifies the underlying stream (e.g. include
 * the runId or projectId in the room name).
 */
export function useLogStream<M extends WsServerMessage>(
	opts: UseLogStreamOptions<M>,
): { lines: LogStreamLine[]; clear: () => void } {
	const { room, messageType, enabled, extractChunk, seedText, maxLines } = opts;
	const cap = maxLines ?? DEFAULT_MAX_LINES;

	const [lines, setLines] = useState<LogStreamLine[]>(() => parseSeedLogText(seedText));
	const linesRef = useRef<LogStreamLine[]>([]);
	linesRef.current = lines;
	const extractRef = useRef(extractChunk);
	extractRef.current = extractChunk;

	const { joinRoom, leaveRoom, subscribe } = useSocket();

	useEffect(() => {
		const seeded = parseSeedLogText(seedText);
		linesRef.current = seeded;
		setLines(seeded);
	}, [seedText]);

	useEffect(() => {
		if (!room || !enabled) return;

		joinRoom(room);

		const unsubscribe = subscribe(messageType, (msg) => {
			const chunk = extractRef.current(msg as M);
			if (!chunk) return;
			const newEntries = chunk.text
				.split('\n')
				.filter((t) => t.length > 0)
				.map((text) => ({ id: nextId(), stream: chunk.stream, text }));
			if (newEntries.length === 0) return;
			linesRef.current = [...linesRef.current, ...newEntries].slice(-cap);
			setLines(linesRef.current);
		});

		return () => {
			unsubscribe();
			leaveRoom(room);
		};
	}, [room, enabled, messageType, cap, joinRoom, leaveRoom, subscribe]);

	const clear = useCallback(() => {
		linesRef.current = [];
		setLines([]);
	}, []);

	return { lines, clear };
}
