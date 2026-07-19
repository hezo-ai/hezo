import { HEZO_DOCS_URL } from '@hezo/shared';

interface SkillTool {
	name: string;
	description: string;
}

/**
 * The agent-facing manifest served at `GET /SKILL.md`: how to connect, how to
 * self-register for access, and the full MCP tool list. `baseUrl` makes the
 * endpoints concrete when known (falls back to relative paths).
 */
export function generateSkillFile(tools: SkillTool[], opts: { baseUrl?: string } = {}): string {
	const base = opts.baseUrl ?? '';
	const lines: string[] = [
		'# Hezo Skill File',
		'',
		'Hezo is an AI-native team management platform. Use the MCP endpoint to manage teams, tasks, projects, agents, and more.',
		'',
		'## Connection',
		'',
		`- **Endpoint:** \`POST ${base}/mcp\` (JSON-RPC, Streamable HTTP)`,
		'- **Authentication:** `Authorization: Bearer <token>`, where the token is a Hezo **API key** (`hezo_…`). Create one in the Hezo web UI, or self-register for one (below). An API key has instance-wide access (every project and team) over MCP.',
		'',
		'## Register for access',
		'',
		'An external agent can self-register for instance access. The registration stays inert until a Hezo admin approves it.',
		'',
		'1. Call the `register` tool over MCP (no token needed) — or `POST ' +
			base +
			'/api/api-keys/register` with `{"name":"<your agent>"}`. You receive a token **once**.',
		'2. Set that token as your `Authorization: Bearer` token.',
		'3. Ask a Hezo admin to approve you at **Settings → API keys**.',
		'4. Poll the `connection_status` tool (or `GET ' +
			base +
			'/api/api-keys/status`) until it returns `{"status":"approved"}`.',
		'5. Once approved, the same token grants full instance access on `POST /mcp`. Pass a `project` slug to project-scoped tools (use `list_projects` to discover them).',
		'',
		'## File uploads',
		'',
		'Binary files (images, PDFs, …) can be written with the `write_project_asset` tool by passing `encoding: "base64"` and the file bytes base64-encoded in `content` (also pass `byte_size`, the file\'s exact byte length, so a truncated payload is rejected instead of stored corrupt). Base64 inflates the JSON-RPC payload ~33% and can be silently truncated by a runtime\'s tool-call argument-size cap, so for any large binary use a `multipart/form-data` POST to `' +
			base +
			"/mcp/assets` (same Bearer auth) using a `file` field — add a `path` field for the full destination path (folders + basename, up to 2 levels, e.g. `launch/images/hero.png`; a folder embedded in the file part's `filename=` works the same way), an optional `overwrite=true` to replace an existing asset in place (like `write_project_asset`; otherwise a colliding name is auto-suffixed), an optional `project` field to act across projects, and the legacy `folder` field (basename placed in a folder; ignored when `path` is given). The JSON response returns the stored asset (including `byte_size`) plus a signed read URL, and the file then shows up in `list_project_assets` / `read_project_asset` under its full path.",
		'',
		'## Documentation',
		'',
		`Full Hezo product & API documentation (concepts, setup, MCP, deployment) lives at ${HEZO_DOCS_URL}. This manifest covers the MCP surface; consult the docs site for everything else.`,
		'',
		'## Available Tools',
		'',
	];

	for (const tool of tools) {
		lines.push(`### \`${tool.name}\``);
		lines.push('');
		lines.push(tool.description);
		lines.push('');
	}

	return lines.join('\n');
}
