/**
 * The `GET /llms.txt` body (llmstxt.org convention). Intentionally minimal: it
 * points at the served `/SKILL.md`, which carries the full MCP tool list plus
 * the connect/register instructions. `baseUrl` makes the links absolute when
 * known (falls back to relative paths).
 */
export function generateLlmsTxt(opts: { baseUrl?: string } = {}): string {
	const base = opts.baseUrl ?? '';
	return [
		'# Hezo',
		'',
		'> Hezo is an AI-native project & team management platform with a built-in MCP',
		'> server, so external AI agents can manage projects, tasks, teams, and agents.',
		'',
		'## MCP API',
		'',
		`- MCP endpoint: \`POST ${base}/mcp\` (JSON-RPC, Streamable HTTP, \`Authorization: Bearer <token>\`).`,
		`- [SKILL.md](${base}/SKILL.md): the full agent manifest — every MCP tool, how to connect, and how to self-register as a connected agent (pending admin approval).`,
		'',
		'## Docs',
		'',
		'- Human documentation lives in the Hezo repository under `docs/` — notably',
		'  `docs/reference/cli.md` (CLI) and `docs/mcp/hezo-mcp-server.md` (MCP server).',
		'',
	].join('\n');
}
