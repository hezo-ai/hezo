import { WsMessageType, wsRoom } from '@hezo/shared';
import type { ContainerEngine } from './docker';
import { DockerFrameDecoder } from './docker-frames';
import type { LogStreamBroker } from './log-stream-broker';

interface StreamState {
	abortController: AbortController;
	refCount: number;
}

const CONTAINER_LOG_CAP_BYTES = 64 * 1024;

function containerStreamId(containerId: string): string {
	return `container:${containerId}`;
}

export class ContainerLogStreamer {
	private streams = new Map<string, StreamState>();

	/**
	 * Follow one container's logs.
	 *
	 * Keyed on the **container**, not its project: a project holds as many
	 * containers as it has concurrent runs, and a project-keyed stream merged
	 * their output into one and served it as whichever container the page was
	 * showing. `projectId` rides along on the message purely so a client can link
	 * back to the project - it is no longer what identifies the stream.
	 */
	subscribe(
		projectId: string,
		containerId: string,
		logs: LogStreamBroker,
		docker: ContainerEngine,
	): void {
		const existing = this.streams.get(containerId);
		if (existing) {
			existing.refCount++;
			return;
		}

		const abortController = new AbortController();
		const state: StreamState = { abortController, refCount: 1 };
		this.streams.set(containerId, state);

		logs.begin({
			streamId: containerStreamId(containerId),
			room: wsRoom.containerLogs(containerId),
			buildMessage: (line) => ({
				type: WsMessageType.ContainerLog,
				containerId,
				projectId,
				stream: line.stream,
				text: line.text,
			}),
			buildSnapshot: (text) => ({
				type: WsMessageType.ContainerLog,
				containerId,
				projectId,
				stream: 'stdout',
				text,
				replace: true,
			}),
			capBytes: CONTAINER_LOG_CAP_BYTES,
		});

		this.startStreaming(containerId, logs, docker, abortController).catch(() => {
			this.streams.delete(containerId);
			void logs.end(containerStreamId(containerId));
		});
	}

	unsubscribe(containerId: string, logs?: LogStreamBroker): void {
		const state = this.streams.get(containerId);
		if (!state) return;

		state.refCount--;
		if (state.refCount <= 0) {
			state.abortController.abort();
			this.streams.delete(containerId);
			if (logs) void logs.end(containerStreamId(containerId));
		}
	}

	stopAll(logs?: LogStreamBroker): void {
		for (const [id, state] of this.streams) {
			state.abortController.abort();
			this.streams.delete(id);
			if (logs) void logs.end(containerStreamId(id));
		}
	}

	private async startStreaming(
		containerId: string,
		logs: LogStreamBroker,
		docker: ContainerEngine,
		abortController: AbortController,
	): Promise<void> {
		const streamId = containerStreamId(containerId);
		const res = await docker.containerLogs(
			containerId,
			{ follow: true, tail: 200, stdout: true, stderr: true },
			abortController.signal,
		);
		if (res === null) return;

		const reader = res.body?.getReader();
		if (!reader) return;

		// Frames go straight to the broker, which coalesces them into periodic
		// batched WS frames for every log stream (see LogStreamBroker). This path
		// used to keep its own 100ms batcher that then re-emitted line by line,
		// so the coalescing never reached the socket.
		const frames = new DockerFrameDecoder();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;

				frames.push(value);
				for (let frame = frames.next(); frame !== null; frame = frames.next()) {
					logs.emit(streamId, frame.stream, frame.text);
				}
			}
			for (const frame of frames.flush()) logs.emit(streamId, frame.stream, frame.text);
		} catch (e) {
			if ((e as Error).name === 'AbortError') return;
			throw e;
		} finally {
			reader.releaseLock();
			this.streams.delete(containerId);
		}
	}
}
