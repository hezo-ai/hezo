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
	/**
	 * Build the replace-snapshot a newly-subscribed client receives.
	 *
	 * `trimmed` says the text is only the tail (see {@link REPLAY_TAIL_CHARS}), so
	 * a client that already seeded the *whole* log from REST can tell that
	 * applying this would be a downgrade rather than a refresh.
	 */
	buildSnapshot: (text: string, trimmed: boolean) => WsEvent;
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

/** A run of consecutive lines on one stream, coalesced into a single WS frame. */
interface PendingBroadcast {
	stream: LogStream;
	lines: string[];
}

interface LogStreamEntry {
	config: LogStreamConfig;
	buffer: CappedLogBuffer;
	dirty: boolean;
	flushTimer: ReturnType<typeof setTimeout> | null;
	ended: boolean;
	/** Chars of the buffer already persisted by a successful onFlush. */
	persistedChars: number;
	/** Tail of the serialized flush chain — every flush awaits its predecessor. */
	flushing: Promise<void> | null;
	/** Lines awaiting their coalesced broadcast, in emission order. */
	pending: PendingBroadcast[];
	pendingLines: number;
	broadcastTimer: ReturnType<typeof setTimeout> | null;
}

// Backstop against a runaway run flooding memory/DB — not a content truncation.
// Sized generously so a whole real run's log (full, untruncated thinking/tool
// output; see agent-stream-parser.ts) is recorded end-to-end without the cap firing.
const DEFAULT_CAP_BYTES = 10_000_000;
const DEFAULT_DEBOUNCE_MS = 500;

/**
 * How long lines accumulate before going out as one frame. A verbose agent emits
 * hundreds of lines a second, and each one used to cost a `JSON.stringify` plus a
 * `send` per subscriber. The client already splits a payload back apart on `\n`,
 * so coalescing is invisible to it and needs no protocol change; only lines on
 * the same stream merge, which keeps stdout/stderr ordering intact.
 */
const BROADCAST_BATCH_MS = 100;

/** Flush early on a burst, so a batch is bounded by content and not just by the timer. */
const MAX_PENDING_BROADCAST_LINES = 500;

/**
 * Cap on the snapshot replayed to a newly-subscribed client. `replay` runs for
 * every live stream in the room, so a project with ten concurrent runs would
 * otherwise push ten whole logs — up to the 10 MB cap each — into one socket the
 * moment a tab opens. The full log stays available from the REST run endpoint,
 * which is what the run view seeds from anyway.
 */
const REPLAY_TAIL_CHARS = 256 * 1024;

const REPLAY_TRIM_NOTICE = '...[earlier output trimmed — open the run to see the full log]';

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
			if (existing.broadcastTimer) clearTimeout(existing.broadcastTimer);
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
			pending: [],
			pendingLines: 0,
			broadcastTimer: null,
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
			if (!wasTruncated) this.queueBroadcast(entry, stream, lineText);
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
			// Anything still queued belongs in the snapshot rather than arriving
			// after it — the snapshot replaces the client's buffer wholesale.
			this.flushBroadcast(entry);
			const trimmed = entry.buffer.length > REPLAY_TAIL_CHARS;
			send(entry.config.buildSnapshot(this.snapshotText(entry), trimmed));
		}
	}

	/**
	 * The replayed snapshot: the tail of the buffer, cut at a line boundary and
	 * flagged when earlier output was left out.
	 */
	private snapshotText(entry: LogStreamEntry): string {
		const total = entry.buffer.length;
		if (total <= REPLAY_TAIL_CHARS) return entry.buffer.toString();
		const tail = entry.buffer.sliceFrom(total - REPLAY_TAIL_CHARS);
		// Drop the partial first line so the client never renders half a line.
		const firstBreak = tail.indexOf('\n');
		const aligned = firstBreak === -1 ? tail : tail.slice(firstBreak + 1);
		return `${REPLAY_TRIM_NOTICE}\n${aligned}`;
	}

	private queueBroadcast(entry: LogStreamEntry, stream: LogStream, text: string): void {
		if (!this.wsManager) return;
		const last = entry.pending[entry.pending.length - 1];
		if (last && last.stream === stream) last.lines.push(text);
		else entry.pending.push({ stream, lines: [text] });
		entry.pendingLines++;

		if (entry.pendingLines >= MAX_PENDING_BROADCAST_LINES) {
			this.flushBroadcast(entry);
			return;
		}
		if (entry.broadcastTimer) return;
		entry.broadcastTimer = setTimeout(() => {
			entry.broadcastTimer = null;
			this.flushBroadcast(entry);
		}, BROADCAST_BATCH_MS);
	}

	private flushBroadcast(entry: LogStreamEntry): void {
		if (entry.broadcastTimer) {
			clearTimeout(entry.broadcastTimer);
			entry.broadcastTimer = null;
		}
		if (entry.pending.length === 0) return;
		const groups = entry.pending;
		entry.pending = [];
		entry.pendingLines = 0;
		if (!this.wsManager) return;
		for (const group of groups) {
			this.wsManager.broadcast(
				entry.config.room,
				entry.config.buildMessage({ stream: group.stream, text: group.lines.join('\n') }),
			);
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
		// The last partial batch still has to reach subscribers; the stream is
		// about to be dropped from the index, so nothing else would send it.
		this.flushBroadcast(entry);
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
			// Offset-addressed, never `toString().slice(...)`: materializing the
			// whole log to find its tail is O(total) twice a second, per run.
			const length = entry.buffer.length;
			const delta = entry.buffer.sliceFrom(entry.persistedChars);
			try {
				await entry.config.onFlush(delta);
				entry.persistedChars = length;
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
