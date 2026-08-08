import { connect, type Socket } from 'node:net';
import type { ConnectTarget, TunnelSocket } from './mux';
import type { TunnelTarget } from './protocol';

/**
 * Binding the multiplexer to real TCP sockets.
 *
 * Kept apart from `mux.ts` so the multiplexer - where all the flow-control
 * logic lives - stays testable against a fake socket with no IO at all. This
 * file is the only place `node:net` appears in the tunnel.
 */

/** Where each target key actually lives on the Hezo host, for one run. */
export interface TargetAddresses {
	proxy: { host: string; port: number };
	mcp: { host: string; port: number };
	ssh: { host: string; port: number };
}

/**
 * Adapt a `net.Socket` to the narrow surface the multiplexer drives.
 *
 * `write` returns Node's own backpressure signal unchanged - false when the
 * kernel buffer is full - because that return value *is* the flow control. A
 * wrapper that swallowed it would silently reintroduce unbounded buffering.
 */
export function nodeTunnelSocket(socket: Socket): TunnelSocket {
	return {
		write: (data) => socket.write(data),
		end: () => {
			socket.end();
		},
		destroy: () => {
			socket.destroy();
		},
		pause: () => {
			socket.pause();
		},
		resume: () => {
			socket.resume();
		},
		onData: (handler) => {
			socket.on('data', (chunk: Buffer) => handler(new Uint8Array(chunk)));
		},
		onEnd: (handler) => {
			// `close` as well as `end`: a socket reset by the peer emits `close`
			// without `end`, and a stream that never learned it was gone would be
			// left open on both sides. The mux's own close is idempotent, so being
			// told twice is harmless while being told never is a leak.
			socket.on('end', handler);
			socket.on('close', handler);
		},
		onError: (handler) => {
			socket.on('error', handler);
		},
		onDrain: (handler) => {
			socket.on('drain', handler);
		},
	};
}

/**
 * A {@link ConnectTarget} over the run's own allocated addresses.
 *
 * The container names a key and this resolves it; the address never comes from
 * the container. That is what makes the target-key design a real boundary
 * rather than a naming convention - there is no code path here that could take
 * a host and port off the wire.
 */
export function connectToRunTargets(addresses: TargetAddresses): ConnectTarget {
	return (target: TunnelTarget) =>
		new Promise((resolve, reject) => {
			const { host, port } = addresses[target];
			const socket = connect({ host, port });
			const onError = (err: Error) => {
				socket.destroy();
				reject(err);
			};
			socket.once('error', onError);
			socket.once('connect', () => {
				socket.removeListener('error', onError);
				resolve(nodeTunnelSocket(socket));
			});
		});
}
