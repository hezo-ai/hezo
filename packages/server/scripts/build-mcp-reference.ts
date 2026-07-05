import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { generateMcpReference, type McpReferenceTool } from '../src/mcp/mcp-reference';
import { ONBOARDING_TOOLS } from '../src/mcp/onboarding';
import { registerTools } from '../src/mcp/tools';

// Generates the user-facing MCP API reference (docs/reference/mcp-api.md) from
// the live tool registry. registerTools() only *registers* tools (it never runs
// a handler), and it derefs neither the db nor the master key during
// registration, so stub deps are safe here — the schemas/descriptions come
// straight from the Zod shapes. Run as part of `bun run build:docs` (before
// bundle-docs.ts, so the freshly written page is embedded in docs-bundle.json).
const server = new McpServer({ name: 'hezo', version: '0.0.0' });
const toolDefs = registerTools(
	server,
	{} as unknown as Db,
	'/tmp/hezo-mcp-reference',
	{} as unknown as MasterKeyManager,
);

const tools: McpReferenceTool[] = toolDefs.map((t) => ({
	name: t.name,
	description: t.description,
	schema: t.params,
	write: t.write,
}));
const onboarding: McpReferenceTool[] = ONBOARDING_TOOLS.map((t) => ({
	name: t.name,
	description: t.description,
	schema: t.inputSchema,
}));

const markdown = generateMcpReference(tools, onboarding);

const outputPath = join(import.meta.dir, '..', '..', '..', 'docs', 'reference', 'mcp-api.md');
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, markdown);
console.log(`Wrote MCP API reference (${tools.length + onboarding.length} tools) → ${outputPath}`);
