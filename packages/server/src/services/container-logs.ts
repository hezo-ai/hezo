import { WsMessageType } from '@hezo/shared';
import type { DockerClient } from './docker';
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
		docker: DockerClient,
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
		docker: DockerClient,
		abortController: AbortController,
	): Promise<void> {
		const streamId = containerStreamId(projectId);
		const res = await docker.containerLogs(
			containerId,
			{ follow: true, tail: 200, stdout: true, stderr: true },
			abortController.signal,
		);

		const reader = res.body?.getReader();
		if (!reader) return;

		const decoder = new TextDecoder();
		let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
		let batchLines: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
		let batchTimer: ReturnType<typeof setTimeout> | null = null;

		const flush = () => {
			if (batchLines.length === 0) return;
			const lines = batchLines;
			batchLines = [];
			for (const line of lines) {
				logs.emit(streamId, line.stream, line.text);
			}
		};

		const scheduleBatch = () => {
			if (batchTimer) return;
			batchTimer = setTimeout(() => {
				batchTimer = null;
				flush();
			}, 100);
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer = concatBuffers(buffer, value);

				while (buffer.length >= 8) {
					const streamType = buffer[0];
					const frameSize = (buffer[4] << 24) | (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];

					if (buffer.length < 8 + frameSize) break;

					const payload = buffer.slice(8, 8 + frameSize);
					buffer = buffer.slice(8 + frameSize);

					const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout';
					const text = decoder.decode(payload);

					batchLines.push({ stream, text });
					scheduleBatch();
				}
			}
		} catch (e) {
			if ((e as Error).name === 'AbortError') return;
			throw e;
		} finally {
			if (batchTimer) clearTimeout(batchTimer);
			flush();
			reader.releaseLock();
			this.streams.delete(projectId);
		}
	}
}

function concatBuffers(
	a: Uint8Array<ArrayBufferLike>,
	b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
	if (a.length === 0) return b;
	const result = new Uint8Array(a.length + b.length);
	result.set(a);
	result.set(b, a.length);
	return result;
}
