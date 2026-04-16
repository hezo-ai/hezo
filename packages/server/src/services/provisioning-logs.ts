import { WsMessageType } from '@hezo/shared';
import type { WebSocketManager } from './ws';

export type ProvisioningLogStream = 'stdout' | 'stderr';

interface BufferedLine {
	stream: ProvisioningLogStream;
	text: string;
}

const BUFFER_MAX_LINES = 500;

export class ProvisioningLogBroadcaster {
	private buffers = new Map<string, BufferedLine[]>();
	private wsManager: WebSocketManager | null = null;

	setWsManager(wsManager: WebSocketManager): void {
		this.wsManager = wsManager;
	}

	emit(projectId: string, stream: ProvisioningLogStream, text: string): void {
		const lines = text.split('\n').filter((l) => l.length > 0);
		if (lines.length === 0) return;

		const buffer = this.buffers.get(projectId) ?? [];
		for (const line of lines) {
			buffer.push({ stream, text: line });
		}
		while (buffer.length > BUFFER_MAX_LINES) buffer.shift();
		this.buffers.set(projectId, buffer);

		if (!this.wsManager) return;
		for (const line of lines) {
			this.wsManager.broadcast(`container-logs:${projectId}`, {
				type: WsMessageType.ContainerLog,
				projectId,
				stream,
				text: line,
			});
		}
	}

	replay(projectId: string, send: (payload: unknown) => void): void {
		const buffer = this.buffers.get(projectId);
		if (!buffer) return;
		for (const line of buffer) {
			send({
				type: WsMessageType.ContainerLog,
				projectId,
				stream: line.stream,
				text: line.text,
			});
		}
	}

	clear(projectId: string): void {
		this.buffers.delete(projectId);
	}
}
