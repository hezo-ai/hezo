/**
 * The per-run manifest the in-container MCP CLI reads.
 *
 * A connector's tool schemas used to be loaded by the runtime's own MCP client,
 * which meant every tool of every connector was resident in the model's context
 * on every request. A real instance carries ~337 of them. The manifest is what
 * replaces that: the run is told which servers exist and how to reach them, and
 * the CLI fetches a schema only when the agent asks for one.
 *
 * **It carries exactly what a runtime descriptor carries** - name, transport,
 * address, headers/env, and the method allowlist - because it is the same
 * information going to a different consumer. `McpDescriptor` is therefore the
 * input type rather than a parallel shape being invented for it.
 *
 * **No secret is in here.** Header and env values keep their
 * `__HEZO_SECRET_<NAME>__` placeholders exactly as the descriptor loader emitted
 * them; the egress proxy substitutes at request time, scoped by the secret's
 * `allowed_hosts`. That is what keeps the § Security red line intact when the
 * caller moves from the runtime's MCP client to this CLI: the call still
 * originates in the container and still traverses the proxy, so nothing about
 * the credential path changes.
 */
import type { McpDescriptor } from '../runtime-adapters/types';
import { CONTAINER_SUBSCRIPTION_BASE } from '../runtime-home';

/** Directory, under the per-run subscription base, holding the CLI and its manifest. */
export const MCP_CLI_DIR = 'mcp-cli';
export const MCP_CLI_MANIFEST_FILENAME = 'manifest.json';
export const MCP_CLI_SCRIPT_FILENAME = 'hezo-mcp.mjs';

/**
 * Container paths. Rooted at the subscription base rather than the per-run home
 * dir because {@link CONTAINER_SUBSCRIPTION_BASE} exists for every runtime,
 * while a home dir does not - Antigravity declares `requiresHomeDir: false`, so
 * a home-rooted CLI would be absent on exactly one of the six.
 */
export const CONTAINER_MCP_CLI_DIR = `${CONTAINER_SUBSCRIPTION_BASE}/${MCP_CLI_DIR}`;
export const CONTAINER_MCP_CLI_MANIFEST = `${CONTAINER_MCP_CLI_DIR}/${MCP_CLI_MANIFEST_FILENAME}`;
export const CONTAINER_MCP_CLI_SCRIPT = `${CONTAINER_MCP_CLI_DIR}/${MCP_CLI_SCRIPT_FILENAME}`;

/** Env var naming the manifest, read by the CLI. */
export const MCP_CLI_MANIFEST_ENV = 'HEZO_MCP_MANIFEST';

/** Where the wrapper that makes `hezo-mcp` a command lands - on every shell's PATH. */
export const CONTAINER_MCP_CLI_BIN_DIR = '/usr/local/bin';
export const MCP_CLI_BIN_NAME = 'hezo-mcp';

/**
 * Agents are told to run `hezo-mcp`, and the script lives in a per-run dir no
 * shell's PATH covers - this wrapper connects the two. A file write rather than
 * a symlink or a PATH edit because the engine file transport is the one delivery
 * mechanism every backend already has, and the runtimes' own shells rebuild
 * PATH however they like.
 */
export const MCP_CLI_WRAPPER_SOURCE = `#!/bin/sh\nexec node ${CONTAINER_MCP_CLI_SCRIPT} "$@"\n`;

export interface McpCliManifestServer {
	name: string;
	transport: 'http' | 'stdio';
	/** http only. */
	url?: string;
	/** http only. Values may carry `__HEZO_SECRET_*__` placeholders. */
	headers?: Record<string, string>;
	/** stdio only. */
	command?: string;
	args?: readonly string[];
	/** stdio only. Values may carry `__HEZO_SECRET_*__` placeholders. */
	env?: Record<string, string>;
	/**
	 * The run's method allowlist, mirrored from the descriptor so the CLI can say
	 * "not enabled for this run" locally instead of making a call the egress
	 * proxy's `mcp-method-guard` will reject anyway.
	 *
	 * Advisory only. The guard remains the enforcement point - a CLI that ignored
	 * this would still be refused - which is what keeps a display concern from
	 * becoming a security one.
	 */
	enabledTools?: readonly string[];
	disabledTools?: readonly string[];
}

export interface McpCliManifest {
	/** Bumped only on a breaking shape change; the CLI refuses a version it does not know. */
	version: 1;
	servers: McpCliManifestServer[];
}

/**
 * Turn the descriptors a run was going to hand its runtime into the manifest the
 * CLI reads instead.
 *
 * `bearerToken` is folded into an `Authorization` header here rather than being
 * carried as its own field: the CLI should have one way to authenticate a
 * request, and the descriptor's two spellings are a convenience for adapters,
 * not a distinction the wire cares about.
 */
export function buildMcpCliManifest(descriptors: readonly McpDescriptor[]): McpCliManifest {
	const servers: McpCliManifestServer[] = [];
	for (const d of descriptors) {
		const restriction = {
			...(d.enabledTools ? { enabledTools: d.enabledTools } : {}),
			...(d.disabledTools ? { disabledTools: d.disabledTools } : {}),
		};
		if (d.kind === 'http') {
			const headers: Record<string, string> = { ...(d.headers ?? {}) };
			if (d.bearerToken) headers.Authorization = `Bearer ${d.bearerToken}`;
			servers.push({
				name: d.name,
				transport: 'http',
				url: d.url,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
				...restriction,
			});
			continue;
		}
		servers.push({
			name: d.name,
			transport: 'stdio',
			command: d.command,
			...(d.args && d.args.length > 0 ? { args: d.args } : {}),
			...(d.env && Object.keys(d.env).length > 0 ? { env: d.env } : {}),
			...restriction,
		});
	}
	return { version: 1, servers };
}

/** The manifest as it is written into the container. */
export function renderMcpCliManifest(descriptors: readonly McpDescriptor[]): string {
	return `${JSON.stringify(buildMcpCliManifest(descriptors), null, 2)}\n`;
}
