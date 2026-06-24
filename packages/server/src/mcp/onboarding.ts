import type { PGlite } from '@electric-sql/pglite';
import { getApiKeyStatusByToken, registerApiKey } from '../services/api-keys';

/**
 * The onboarding tools served on `/mcp` to callers that are NOT yet an approved
 * principal (no token, an invalid token, or a still-`pending` registration token).
 * They let an external agent self-register and poll for approval without any prior
 * credential. They live outside the normal tool registry/authContext, so they
 * never touch tool authorization.
 */
export const REGISTER_TOOL = 'register';
export const CONNECTION_STATUS_TOOL = 'connection_status';

export const ONBOARDING_TOOL_NAMES: ReadonlySet<string> = new Set([
	REGISTER_TOOL,
	CONNECTION_STATUS_TOOL,
]);

/** MCP `tools/list` shape (name/description/inputSchema). */
export interface McpToolShape {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const ONBOARDING_TOOLS: McpToolShape[] = [
	{
		name: REGISTER_TOOL,
		description:
			'Register this agent with Hezo. Returns an access token (shown once) — set it as your `Authorization: Bearer` token. The registration is inert until a Hezo admin approves it under Settings → API keys; once approved you have full instance access (every project and team). Poll `connection_status` to learn when you are approved.',
		inputSchema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'A human-readable name for this agent, shown to the admin who approves it.',
				},
				client_info: {
					type: 'object',
					description: 'Optional MCP client info (e.g. {"name":"claude","version":"…"}).',
				},
			},
			required: ['name'],
		},
	},
	{
		name: CONNECTION_STATUS_TOOL,
		description:
			'Check whether this agent has been approved yet. Send your token as the `Authorization: Bearer` token. Returns {"status":"pending"} or {"status":"approved"}.',
		inputSchema: { type: 'object', properties: {} },
	},
];

/** Handle a `register` tool call. Returns a plain object the caller serializes. */
export async function handleRegisterTool(
	db: PGlite,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const name = typeof args.name === 'string' ? args.name.trim() : '';
	if (!name) return { error: 'name is required' };
	const clientInfo =
		args.client_info && typeof args.client_info === 'object'
			? (args.client_info as Record<string, unknown>)
			: undefined;

	const result = await registerApiKey(db, { name, clientInfo });
	return {
		id: result.id,
		token: result.token,
		status: result.status,
		message:
			'Registered. Set this token as your `Authorization: Bearer <token>`. A Hezo admin must approve you under Settings → API keys before you gain access; poll `connection_status` to check.',
	};
}

/** Handle a `connection_status` tool call, keyed by the request's bearer token. */
export async function handleConnectionStatusTool(
	db: PGlite,
	token: string | null,
): Promise<Record<string, unknown>> {
	if (!token) {
		return {
			error:
				'No bearer token. Call `register` first, then send the returned token as your Authorization: Bearer.',
		};
	}
	const status = await getApiKeyStatusByToken(db, token);
	if (!status) return { error: 'Unknown token — not a registered agent.' };
	return { status: status.status };
}
