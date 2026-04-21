import { CappedLogBuffer } from './log-buffer';
import type { WebSocketManager, WsEvent } from './ws';

export type LogStream = 'stdout' | 'stderr';

export interface LogLine {
	stream: LogStream;
	text: string;
}

export interface LogStreamConfig {
	streamId: string;
	room: string;
	buildMessage: (line: LogLine) => WsEvent;
	onFlush?: (text: string) => Promise<void>;
	capBytes?: number;
	debounceMs?: number;
}

interface LogStreamEntry {
	config: LogStreamConfig;
	buffer: CappedLogBuffer;
	lines: LogLine[];
	dirty: boolean;
	flushTimer: ReturnType<typeof setTimeout> | null;
	ended: boolean;
}

const DEFAULT_CAP_BYTES = 1_000_000;
const DEFAULT_DEBOUNCE_MS = 500;

export class LogStreamBroker {
	private streams = new Map<string, LogStreamEntry>();
	private roomIndex = new Map<string, Set<string>>();
	private wsManager: WebSocketManager | null = null;

	setWsManager(wsManager: WebSocketManager): void {
		this.wsManager = wsManager;
	}

	begin(config: LogStreamConfig): void {
		const existing = this.streams.get(config.streamId);
		if (existing) {
			if (existing.flushTimer) clearTimeout(existing.flushTimer);
			this.removeFromRoomIndex(existing.config.room, config.streamId);
		}

		const entry: LogStreamEntry = {
			config,
			buffer: new CappedLogBuffer(config.capBytes ?? DEFAULT_CAP_BYTES),
			lines: [],
			dirty: false,
			flushTimer: null,
			ended: false,
		};
		this.streams.set(config.streamId, entry);

		let roomStreams = this.roomIndex.get(config.room);
		if (!roomStreams) {
			roomStreams = new Set();
			this.roomIndex.set(config.room, roomStreams);
		}
		roomStreams.add(config.streamId);
	}

	emit(streamId: string, stream: LogStream, text: string): void {
		const entry = this.streams.get(streamId);
		if (!entry || entry.ended) return;

		const newLines = text
			.split('\n')
			.filter((l) => l.length > 0)
			.map((l) => ({ stream, text: l }));
		if (newLines.length === 0) return;

		const wasTruncated = entry.buffer.isTruncated;
		entry.buffer.append(stream, text);
		if (!wasTruncated) {
			for (const line of newLines) {
				entry.lines.push(line);
				if (this.wsManager) {
					this.wsManager.broadcast(entry.config.room, entry.config.buildMessage(line));
				}
			}
		}

		if (entry.config.onFlush) {
			entry.dirty = true;
			this.scheduleFlush(entry);
		}
	}

	replay(room: string, send: (payload: unknown) => void): void {
		const streamIds = this.roomIndex.get(room);
		if (!streamIds) return;
		for (const streamId of streamIds) {
			const entry = this.streams.get(streamId);
			if (!entry) continue;
			for (const line of entry.lines) {
				send(entry.config.buildMessage(line));
			}
		}
	}

	async end(streamId: string): Promise<void> {
		const entry = this.streams.get(streamId);
		if (!entry) return;
		entry.ended = true;
		if (entry.flushTimer) {
			clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
		}
		if (entry.dirty && entry.config.onFlush) {
			entry.dirty = false;
			await entry.config.onFlush(entry.buffer.toString());
		}
		this.streams.delete(streamId);
		this.removeFromRoomIndex(entry.config.room, streamId);
	}

	getLogText(streamId: string): string {
		const entry = this.streams.get(streamId);
		return entry ? entry.buffer.toString() : '';
	}

	isActive(streamId: string): boolean {
		const entry = this.streams.get(streamId);
		return !!entry && !entry.ended;
	}

	private scheduleFlush(entry: LogStreamEntry): void {
		if (entry.flushTimer || !entry.config.onFlush) return;
		const debounce = entry.config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		entry.flushTimer = setTimeout(() => {
			entry.flushTimer = null;
			void this.performFlush(entry);
		}, debounce);
	}

	private async performFlush(entry: LogStreamEntry): Promise<void> {
		if (!entry.dirty || !entry.config.onFlush || entry.ended) return;
		entry.dirty = false;
		const text = entry.buffer.toString();
		try {
			await entry.config.onFlush(text);
		} catch {
			entry.dirty = true;
		}
		if (entry.dirty && !entry.ended) this.scheduleFlush(entry);
	}

	private removeFromRoomIndex(room: string, streamId: string): void {
		const streamIds = this.roomIndex.get(room);
		if (!streamIds) return;
		streamIds.delete(streamId);
		if (streamIds.size === 0) this.roomIndex.delete(room);
	}
}
