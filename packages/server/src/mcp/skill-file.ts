interface SkillTool {
	name: string;
	description: string;
}

/**
 * The agent-facing manifest served at `GET /SKILL.md`: how to connect, how to
 * self-register as a connected agent, and the full MCP tool list. `baseUrl`
 * makes the endpoints concrete when known (falls back to relative paths).
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
		'- **Authentication:** `Authorization: Bearer <token>`, where the token is one of:',
		'  - a **team-scoped API key** (`hezo_…`) created in the Hezo web UI, or',
		'  - an **instance-wide connected-agent token** (`hezoc_…`) obtained via the registration flow below.',
		'',
		'## Register as a connected agent',
		'',
		'An external agent can self-register for instance-wide access (every project and team). The registration stays inert until a Hezo admin approves it.',
		'',
		'1. Call the `register` tool over MCP (no token needed) — or `POST ' +
			base +
			'/api/agent-connections/register` with `{"name":"<your agent>"}`. You receive a `hezoc_…` token **once**.',
		'2. Set that token as your `Authorization: Bearer` token.',
		'3. Ask a Hezo admin to approve you at **Settings → Connected agents**.',
		'4. Poll the `connection_status` tool (or `GET ' +
			base +
			'/api/agent-connections/status`) until it returns `{"status":"approved"}`.',
		'5. Once approved, the same token grants full instance access on `POST /mcp`. Pass a `project` slug to project-scoped tools (use `list_projects` to discover them).',
		'',
		'## File uploads',
		'',
		'Binary files (images, PDFs, …) cannot be sent as a JSON-RPC tool call. Upload them with a `multipart/form-data` POST to `' +
			base +
			'/mcp/assets` (same Bearer auth) using a `file` field — add an optional `project` field to act across projects. The response returns the stored asset plus a signed read URL, and the file then shows up in `list_project_assets` / `read_project_asset`.',
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
