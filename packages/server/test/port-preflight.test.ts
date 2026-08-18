import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { formatPortInUseMessage, probePort } from '../src/services/port-preflight';

/** Bind a throwaway listener on an OS-assigned free port and return both. */
function listenOnFreePort(host = '0.0.0.0'): Promise<{ server: Server; port: number }> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, host, () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') resolve({ server, port: addr.port });
			else reject(new Error('no port assigned'));
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

describe('probePort', () => {
	let occupied: Server | null = null;
	afterEach(async () => {
		if (occupied) await close(occupied);
		occupied = null;
	});

	it('reports a free port as available', async () => {
		// Grab a free port, release it, then probe it — nothing is listening, so the
		// probe must be able to bind.
		const { server, port } = await listenOnFreePort();
		await close(server);
		const result = await probePort(port);
		expect(result.available).toBe(true);
		expect(result.code).toBeUndefined();
	});

	it('reports a port held by another listener as unavailable with EADDRINUSE', async () => {
		const { server, port } = await listenOnFreePort();
		occupied = server;
		const result = await probePort(port);
		expect(result.available).toBe(false);
		expect(result.code).toBe('EADDRINUSE');
	});

	it('does not leave its own listener bound (the port is free again afterwards)', async () => {
		// A free-port probe must release the throwaway socket so Bun can bind for
		// real; a second probe of the same port therefore still reports available.
		const { server, port } = await listenOnFreePort();
		await close(server);
		expect((await probePort(port)).available).toBe(true);
		expect((await probePort(port)).available).toBe(true);
	});
});

describe('formatPortInUseMessage', () => {
	it('names the taken port and points at both --port and the config key', () => {
		const msg = formatPortInUseMessage(3100);
		expect(msg).toContain('3100');
		expect(msg).toContain('--port');
		expect(msg).toContain('--config');
		// The env var stopped being read in 0.50; suggesting it would send the
		// operator somewhere that does nothing.
		expect(msg).not.toContain('HEZO_PORT');
	});

	it('suggests a concrete alternative port', () => {
		// The example nudges the operator to a port they can actually try.
		expect(formatPortInUseMessage(3100)).toContain('3101');
	});
});
