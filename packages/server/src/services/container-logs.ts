import { WsMessageType } from '@hezo/shared';
import type { ContainerEngine } from './docker';
import { DockerFrameDecoder } from './docker-frames';
import type { LogStreamBroker } from './log-stream-broker';

interface StreamState {
	abortController: AbortController;
	refCount: number;
}

const CONTAINER_LOG_CAP_BYTES = 64 * 1024;

function containerStreamId(projectId: string): string {
	return `container:${projectId}`;
}

export class ContainerLogStreamer {
	private streams = new Map<string, StreamState>();

	subscribe(
		projectId: string,
		containerId: string,
		logs: LogStreamBroker,
		docker: ContainerEngine,
	): void {
		const existing = this.streams.get(projectId);
		if (existing) {
			existing.refCount++;
			return;
		}

		const abortController = new AbortController();
		const state: StreamState = { abortController, refCount: 1 };
		this.streams.set(projectId, state);

		logs.begin({
			streamId: containerStreamId(projectId),
			room: `container-logs:${projectId}`,
			buildMessage: (line) => ({
				type: WsMessageType.ContainerLog,
				projectId,
				stream: line.stream,
				text: line.text,
			}),
			buildSnapshot: (text) => ({
				type: WsMessageType.ContainerLog,
				projectId,
				stream: 'stdout',
				text,
				replace: true,
			}),
			capBytes: CONTAINER_LOG_CAP_BYTES,
		});

		this.startStreaming(projectId, containerId, logs, docker, abortController).catch(() => {
			this.streams.delete(projectId);
			void logs.end(containerStreamId(projectId));
		});
	}

	unsubscribe(projectId: string, logs?: LogStreamBroker): void {
		const state = this.streams.get(projectId);
		if (!state) return;

		state.refCount--;
		if (state.refCount <= 0) {
			state.abortController.abort();
			this.streams.delete(projectId);
			if (logs) void logs.end(containerStreamId(projectId));
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
		projectId: string,
		containerId: string,
		logs: LogStreamBroker,
		docker: ContainerEngine,
		abortController: AbortController,
	): Promise<void> {
		const streamId = containerStreamId(projectId);
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
			this.streams.delete(projectId);
		}
	}
}
