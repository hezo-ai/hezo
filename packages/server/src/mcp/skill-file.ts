import type { ToolDef } from './tools';

export function generateSkillFile(tools: ToolDef[]): string {
	const lines: string[] = [
		'# Hezo Skill File',
		'',
		'Hezo is an AI-native company management platform. Use the MCP endpoint to manage companies, issues, projects, agents, and more.',
		'',
		'## Connection',
		'',
		'- **Endpoint:** `POST /mcp` (Streamable HTTP)',
		'- **Authentication:** Bearer token (JWT or API key starting with `hezo_`)',
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
