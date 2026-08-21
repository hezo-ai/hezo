import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import {
	generateMcpReference,
	MCP_REFERENCE_CATEGORY_ORDER,
	type McpReferenceTool,
	mcpConventionLines,
	TOOL_DOC_META,
} from '../src/mcp/mcp-reference';
import { ONBOARDING_TOOLS } from '../src/mcp/onboarding';
import { registerTools } from '../src/mcp/tools';
import { parseDoc } from '../src/services/docs-bundle';

// The committed reference lives at the repo root. This mirrors how the build
// script (scripts/build-mcp-reference.ts) writes it, so the freshness check
// compares like-for-like.
const here = fileURLToPath(new URL('.', import.meta.url));
const REFERENCE_PATH = join(here, '..', '..', '..', 'docs', 'reference', 'mcp-api.md');

/**
 * Enumerate the reference tools the same way the build script does: registration
 * never derefs the db / master key (no handler runs), so stub deps are safe and
 * the schemas/descriptions come straight from the Zod shapes.
 */
function collectReferenceTools(): { tools: McpReferenceTool[]; onboarding: McpReferenceTool[] } {
	const server = new McpServer({ name: 'hezo', version: '0.0.0' });
	const toolDefs = registerTools(
		server,
		{} as unknown as Db,
		'/tmp/hezo-mcp-reference',
		{} as unknown as MasterKeyManager,
	);
	const tools = toolDefs.map((t) => ({
		name: t.name,
		description: t.description,
		schema: t.params,
		write: t.write,
	}));
	const onboarding = ONBOARDING_TOOLS.map((t) => ({
		name: t.name,
		description: t.description,
		schema: t.inputSchema,
	}));
	return { tools, onboarding };
}

describe('MCP API reference (docs/reference/mcp-api.md)', () => {
	it('is up to date with the tool registry (run `bun run build:docs` if this fails)', () => {
		const { tools, onboarding } = collectReferenceTools();
		const expected = generateMcpReference(tools, onboarding);
		const actual = readFileSync(REFERENCE_PATH, 'utf-8');
		expect(actual).toBe(expected);
	});

	it('documents every registered tool with no stale entries', () => {
		const { tools, onboarding } = collectReferenceTools();
		const registered = [...tools, ...onboarding].map((t) => t.name).sort();
		const documented = Object.keys(TOOL_DOC_META).sort();

		const missing = registered.filter((n) => !TOOL_DOC_META[n]);
		const stale = documented.filter((n) => !registered.includes(n));
		expect(missing).toEqual([]);
		expect(stale).toEqual([]);
	});

	it('assigns every tool to a known category', () => {
		const known = new Set(MCP_REFERENCE_CATEGORY_ORDER);
		const bad = Object.entries(TOOL_DOC_META)
			.filter(([, meta]) => !known.has(meta.category))
			.map(([name]) => name);
		expect(bad).toEqual([]);
	});

	it('carries frontmatter that places it in the Reference section', () => {
		const doc = parseDoc(readFileSync(REFERENCE_PATH, 'utf-8'));
		expect(doc.title).toBe('MCP API reference');
		expect(doc.section).toBe('Reference');
		expect(doc.order).toBe(32);
	});
});

describe('registry conventions', () => {
	// Authored once and rendered to two surfaces: the reference page prints them
	// as a section, the MCP server sends them as `initialize` instructions. One
	// source is the point - a convention stated per tool costs its bytes once per
	// tool on every `tools/list`.
	it('renders the same conventions to both surfaces, bar the page furniture', () => {
		const docs = mcpConventionLines('docs');
		const wire = mcpConventionLines('wire');
		expect(wire.length).toBe(docs.length);
		const differing = docs.filter((line, i) => line !== wire[i]);
		// Exactly the two clauses that point at the reference page's own layout.
		expect(differing).toEqual([
			'  **Authorization** below.',
			expect.stringContaining('_Write tool_'),
		]);
	});

	it('covers the conventions no single tool schema can convey', () => {
		const wire = mcpConventionLines('wire').join('\n');
		for (const topic of ['`project`', 'Paging is the norm', 'result_too_large', 'excerpt_chars']) {
			expect(wire, topic).toContain(topic);
		}
	});
});
