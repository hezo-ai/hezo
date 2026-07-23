import { logger } from '../logger';
import { CappedLogBuffer } from './log-buffer';
import { splitLogLines } from './log-format';
import type { WebSocketManager, WsEvent } from './ws';

const log = logger.child('log-stream');

export type LogStream = 'stdout' | 'stderr';

export interface LogLine {
	stream: LogStream;
	text: string;
}

export interface LogStreamConfig {
	streamId: string;
	room: string;
	buildMessage: (line: LogLine) => WsEvent;
	buildSnapshot: (text: string) => WsEvent;
	/**
	 * Persistence callback. Receives only the text appended since the last
	 * SUCCESSFUL flush (the delta), so implementations append it — they must
	 * never treat it as the whole log. A throw re-marks the stream dirty and the
	 * same delta is re-sent on the next flush, so the callback must persist the
	 * delta atomically (all-or-nothing) to stay exactly-once. An empty-string
	 * delta is still delivered when the buffer is dirty-but-capped — callbacks
	 * that piggyback other state (usage snapshots) on the flush cadence rely on
	 * the call happening.
	 */
	onFlush?: (delta: string) => Promise<void>;
	capBytes?: number;
	debounceMs?: number;
}

interface LogStreamEntry {
	config: LogStreamConfig;
	buffer: CappedLogBuffer;
	dirty: boolean;
	flushTimer: ReturnType<typeof setTimeout> | null;
	ended: boolean;
	/** Chars of `buffer.toString()` already persisted by a successful onFlush. */
	persistedChars: number;
	/** Tail of the serialized flush chain — every flush awaits its predecessor. */
	flushing: Promise<void> | null;
}

// Backstop against a runaway run flooding memory/DB — not a content truncation.
// Sized generously so a whole real run's log (full, untruncated thinking/tool
// output; see agent-stream-parser.ts) is recorded end-to-end without the cap firing.
const DEFAULT_CAP_BYTES = 10_000_000;
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
			dirty: false,
			flushTimer: null,
			ended: false,
			persistedChars: 0,
			flushing: null,
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

		// Collapse carriage-return progress redraws and split into discrete lines
		// once, so the live broadcast and the persisted snapshot stay identical.
		const lines = splitLogLines(text);
		if (lines.length === 0) return;

		for (const lineText of lines) {
			const wasTruncated = entry.buffer.isTruncated;
			entry.buffer.append(stream, lineText);
			if (!wasTruncated && this.wsManager) {
				this.wsManager.broadcast(
					entry.config.room,
					entry.config.buildMessage({ stream, text: lineText }),
				);
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
			send(entry.config.buildSnapshot(entry.buffer.toString()));
		}
	}

	/**
	 * Final-flush and tear down a stream. Drains any in-flight flush, then
	 * persists the remaining unflushed tail. Unlike a mid-run flush there is no
	 * retry after this — a persistence failure here is logged and the tail is
	 * dropped (the run is finishing regardless; failing finalization over a log
	 * tail would be worse).
	 */
	async end(streamId: string): Promise<void> {
		const entry = this.streams.get(streamId);
		if (!entry) return;
		entry.ended = true;
		if (entry.flushTimer) {
			clearTimeout(entry.flushTimer);
			entry.flushTimer = null;
		}
		await this.flushDelta(entry);
		if (entry.dirty) {
			log.warn(
				`Final log flush failed for stream ${streamId}; trailing log text was not persisted`,
			);
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
		if (entry.ended) return;
		await this.flushDelta(entry);
		if (entry.dirty && !entry.ended) this.scheduleFlush(entry);
	}

	/**
	 * The single serialized persistence path: every call chains on the previous
	 * flush's promise, so two flushes can never overlap — an overlap would
	 * compute its delta from a not-yet-advanced offset and persist the same text
	 * twice. `persistedChars` advances only after `onFlush` succeeds; on failure
	 * the stream is re-marked dirty and the identical delta goes out on the next
	 * attempt. Delta extraction by offset is sound because
	 * `CappedLogBuffer.toString()` is prefix-stable (append-only; the truncation
	 * marker is appended once at the cap, after which nothing changes).
	 */
	private flushDelta(entry: LogStreamEntry): Promise<void> {
		const prev = entry.flushing ?? Promise.resolve();
		const next = prev.then(async () => {
			if (!entry.dirty || !entry.config.onFlush) return;
			entry.dirty = false;
			const text = entry.buffer.toString();
			const delta = text.slice(entry.persistedChars);
			try {
				await entry.config.onFlush(delta);
				entry.persistedChars = text.length;
			} catch {
				entry.dirty = true;
			}
		});
		const guarded = next.finally(() => {
			if (entry.flushing === guarded) entry.flushing = null;
		});
		entry.flushing = guarded;
		return guarded;
	}

	private removeFromRoomIndex(room: string, streamId: string): void {
		const streamIds = this.roomIndex.get(room);
		if (!streamIds) return;
		streamIds.delete(streamId);
		if (streamIds.size === 0) this.roomIndex.delete(room);
	}
}
