const SOCKET_PATH = '/var/run/docker.sock';
const API_VERSION = 'v1.44';

interface ContainerConfig {
	Image: string;
	Cmd?: string[];
	Env?: string[];
	WorkingDir?: string;
	HostConfig: {
		Binds?: string[];
		PortBindings?: Record<string, Array<{ HostPort: string }>>;
		ExtraHosts?: string[];
	};
	ExposedPorts?: Record<string, object>;
}

interface ExecConfig {
	Cmd: string[];
	Env?: string[];
	WorkingDir?: string;
	User?: string;
	AttachStdout: boolean;
	AttachStderr: boolean;
}

export interface ExecLogChunk {
	stream: 'stdout' | 'stderr';
	text: string;
}

export interface ExecStartOpts {
	signal?: AbortSignal;
	onChunk?: (chunk: ExecLogChunk) => void | Promise<void>;
}

interface ContainerInfo {
	Id: string;
	State: {
		Status: string;
		Running: boolean;
		Pid: number;
		ExitCode: number;
	};
	Config: {
		Image: string;
	};
}

export class DockerClient {
	private socketPath: string;

	constructor(socketPath = SOCKET_PATH) {
		this.socketPath = socketPath;
	}

	private async request(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<Response> {
		const url = `http://localhost/${API_VERSION}${path}`;
		const res = await fetch(url, {
			method,
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			unix: this.socketPath,
			signal,
		});
		return res;
	}

	async ping(): Promise<boolean> {
		try {
			const res = await this.request('GET', '/_ping');
			return res.ok;
		} catch {
			return false;
		}
	}

	async imageExists(image: string): Promise<boolean> {
		const res = await this.request('GET', `/images/${encodeURIComponent(image)}/json`);
		if (res.ok) {
			await res.text();
			return true;
		}
		await res.text();
		return false;
	}

	async pullImage(image: string): Promise<void> {
		const res = await this.request('POST', `/images/create?fromImage=${encodeURIComponent(image)}`);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker pullImage failed (${res.status}): ${text}`);
		}
		await res.text();
	}

	async createContainer(
		name: string,
		config: ContainerConfig,
	): Promise<{ Id: string; Warnings: string[] }> {
		const res = await this.request(
			'POST',
			`/containers/create?name=${encodeURIComponent(name)}`,
			config,
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker createContainer failed (${res.status}): ${text}`);
		}
		return res.json();
	}

	async startContainer(containerId: string): Promise<void> {
		const res = await this.request('POST', `/containers/${containerId}/start`);
		if (!res.ok && res.status !== 304) {
			const text = await res.text();
			throw new Error(`Docker startContainer failed (${res.status}): ${text}`);
		}
	}

	async stopContainer(containerId: string, timeoutSec = 10): Promise<void> {
		const res = await this.request('POST', `/containers/${containerId}/stop?t=${timeoutSec}`);
		if (!res.ok && res.status !== 304) {
			const text = await res.text();
			throw new Error(`Docker stopContainer failed (${res.status}): ${text}`);
		}
	}

	async removeContainer(containerId: string, force = false): Promise<void> {
		const res = await this.request('DELETE', `/containers/${containerId}?force=${force}&v=true`);
		if (!res.ok && res.status !== 404) {
			const text = await res.text();
			throw new Error(`Docker removeContainer failed (${res.status}): ${text}`);
		}
	}

	async inspectContainer(containerId: string): Promise<ContainerInfo | null> {
		const res = await this.request('GET', `/containers/${containerId}/json`);
		if (res.status === 404) {
			await res.text();
			return null;
		}
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker inspectContainer failed (${res.status}): ${text}`);
		}
		return res.json();
	}

	async inspectContainerByName(name: string): Promise<ContainerInfo | null> {
		return this.inspectContainer(name);
	}

	async containerLogs(
		containerId: string,
		opts: { follow?: boolean; tail?: number; stdout?: boolean; stderr?: boolean } = {},
		signal?: AbortSignal,
	): Promise<Response> {
		const params = new URLSearchParams({
			follow: String(opts.follow ?? true),
			stdout: String(opts.stdout ?? true),
			stderr: String(opts.stderr ?? true),
			tail: String(opts.tail ?? 200),
		});
		const url = `http://localhost/${API_VERSION}/containers/${containerId}/logs?${params}`;
		const res = await fetch(url, {
			unix: this.socketPath,
			signal,
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker containerLogs failed (${res.status}): ${text}`);
		}
		return res;
	}

	async execCreate(containerId: string, config: ExecConfig): Promise<string> {
		const res = await this.request('POST', `/containers/${containerId}/exec`, config);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker execCreate failed (${res.status}): ${text}`);
		}
		const data = (await res.json()) as { Id: string };
		return data.Id;
	}

	async execStart(
		execId: string,
		opts: ExecStartOpts = {},
	): Promise<{ stdout: string; stderr: string }> {
		const res = await this.request(
			'POST',
			`/exec/${execId}/start`,
			{ Detach: false, Tty: false },
			opts.signal,
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker execStart failed (${res.status}): ${text}`);
		}

		if (!opts.onChunk) {
			const raw = new Uint8Array(await res.arrayBuffer());
			return demuxDockerStream(raw);
		}

		return streamDockerExec(res, opts.onChunk, opts.signal);
	}

	async execInspect(execId: string): Promise<{ ExitCode: number; Running: boolean; Pid: number }> {
		const res = await this.request('GET', `/exec/${execId}/json`);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Docker execInspect failed (${res.status}): ${text}`);
		}
		return res.json();
	}
}

function demuxDockerStream(raw: Uint8Array): { stdout: string; stderr: string } {
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	let offset = 0;

	while (offset + 8 <= raw.length) {
		const streamType = raw[offset];
		const size =
			(raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
		offset += 8;

		if (offset + size > raw.length) break;

		const chunk = raw.slice(offset, offset + size);
		if (streamType === 1) {
			stdout.push(chunk);
		} else if (streamType === 2) {
			stderr.push(chunk);
		}
		offset += size;
	}

	const decoder = new TextDecoder();
	return {
		stdout: decoder.decode(concatUint8Arrays(stdout)),
		stderr: decoder.decode(concatUint8Arrays(stderr)),
	};
}

async function streamDockerExec(
	res: Response,
	onChunk: (c: ExecLogChunk) => void | Promise<void>,
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
	const reader = res.body?.getReader();
	if (!reader) return { stdout: '', stderr: '' };

	const decoder = new TextDecoder();
	const stdoutParts: string[] = [];
	const stderrParts: string[] = [];
	let buffer = new Uint8Array(0);

	const drainFrames = async () => {
		while (buffer.length >= 8) {
			const streamType = buffer[0];
			const size = (buffer[4] << 24) | (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];
			if (buffer.length < 8 + size) break;
			const payload = buffer.slice(8, 8 + size);
			buffer = buffer.slice(8 + size);
			const text = decoder.decode(payload);
			const stream: 'stdout' | 'stderr' = streamType === 2 ? 'stderr' : 'stdout';
			if (stream === 'stdout') stdoutParts.push(text);
			else stderrParts.push(text);
			await onChunk({ stream, text });
		}
	};

	try {
		while (true) {
			if (signal?.aborted) {
				throw new DOMException('Aborted', 'AbortError');
			}
			const { done, value } = await reader.read();
			if (done) break;
			if (value) {
				const next = new Uint8Array(buffer.length + value.length);
				next.set(buffer);
				next.set(value, buffer.length);
				buffer = next;
				await drainFrames();
			}
		}
		await drainFrames();
	} finally {
		reader.releaseLock();
	}

	return { stdout: stdoutParts.join(''), stderr: stderrParts.join('') };
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
	if (arrays.length === 0) return new Uint8Array(0);
	if (arrays.length === 1) return arrays[0];
	const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}
