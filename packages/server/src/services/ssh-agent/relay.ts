export const BRIDGE_RUNNER_BINARY = '/usr/local/bin/hezo-run-with-bridge';
export const BRIDGE_HELPER_BINARY = '/usr/local/bin/hezo-ssh-bridge';

export interface BridgeRunnerArgs {
	/** In-container path where socat will create the Unix socket. */
	socketPath: string;
	/** Owner uid name for the in-container socket (matches the agent CLI's user). */
	socketUser: string;
	/** Lowercase hex (32 chars) of the per-run authentication token. */
	tokenHex: string;
	/** Host name reachable from inside the container; usually `host.docker.internal`. */
	hostName: string;
	/** Loopback TCP port the SshAgentServer is listening on for this run. */
	hostPort: number;
}

const SOCKET_PATH_RE = /^\/[\w./-]+$/;
const SOCKET_USER_RE = /^[\w-]+$/;
const HOST_NAME_RE = /^[\w.-]+$/;
const TOKEN_HEX_RE = /^[0-9a-f]{32}$/;

export function buildBridgeRunnerArgv(args: BridgeRunnerArgs): string[] {
	if (!TOKEN_HEX_RE.test(args.tokenHex)) {
		throw new Error('invalid token hex: expected 32 lowercase hex chars');
	}
	if (!SOCKET_PATH_RE.test(args.socketPath)) {
		throw new Error(`invalid socket path: ${args.socketPath}`);
	}
	if (!SOCKET_USER_RE.test(args.socketUser)) {
		throw new Error(`invalid socket user: ${args.socketUser}`);
	}
	if (!HOST_NAME_RE.test(args.hostName)) {
		throw new Error(`invalid host name: ${args.hostName}`);
	}
	if (!Number.isInteger(args.hostPort) || args.hostPort <= 0 || args.hostPort > 65535) {
		throw new Error(`invalid host port: ${args.hostPort}`);
	}
	return [
		BRIDGE_RUNNER_BINARY,
		args.socketPath,
		args.socketUser,
		args.tokenHex,
		`${args.hostName}:${args.hostPort}`,
		'--',
	];
}
