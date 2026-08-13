import { CAPTAIN_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import {
	authoredPromptError,
	authoredPromptWarning,
	findSharedInstructionDuplicates,
	resetSharedInstructionBullets,
} from '../src/services/prompt-style-guard';
import { SHARED_INSTRUCTIONS_TEXT } from '../src/services/template-resolver';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	mintAgentToken,
} from './helpers/app';
import { compliantPrompt } from './helpers/prompt';

/**
 * Guard: every surface that accepts an authored prompt runs the house register.
 *
 * The reach rule this enforces is AGENTS.md § Layout - state a rule once, in
 * the highest-reaching surface that covers its audience. A role prompt that
 * repeats a SHARED_INSTRUCTIONS bullet is pure duplication, and the copy is
 * what goes stale (which is how qa-engineer.md and engineer.md ended up with
 * opposite models of the phased-merge protocol).
 */
describe('duplicates-SHARED_INSTRUCTIONS detection', () => {
	beforeAll(() => resetSharedInstructionBullets());
	afterAll(() => resetSharedInstructionBullets());

	/** A real bullet from the shared guidance, taken live so it cannot go stale. */
	function aSharedBullet(): string {
		const bullet = SHARED_INSTRUCTIONS_TEXT.split('\n').find(
			(l) => /^-\s+\*\*/.test(l) && l.split(/\s+/).length > 25,
		);
		if (!bullet) throw new Error('no comparable bullet found in SHARED_INSTRUCTIONS');
		return bullet;
	}

	it('flags a bullet copied verbatim out of the shared guidance', () => {
		const findings = findSharedInstructionDuplicates(`# Role\n\n${aSharedBullet()}\n`);
		expect(findings).toHaveLength(1);
		expect(findings[0].rule).toBe('duplicates_shared');
		expect(findings[0].severity).toBe('error');
	});

	it('flags it through the same decoration differences a re-typing introduces', () => {
		const restyled = aSharedBullet().replace(/\*\*/g, '').replace(/^-\s+/, '-   ');
		expect(findSharedInstructionDuplicates(restyled)).toHaveLength(1);
	});

	it('leaves a role-specific rule alone', () => {
		const own =
			'- **Never merge a PR with a red required check.** Fix CI on the branch and hand back to QA.';
		expect(findSharedInstructionDuplicates(own)).toEqual([]);
	});

	it('ignores prose and short bullets, which cannot match meaningfully', () => {
		expect(findSharedInstructionDuplicates('Read the thread before you act.')).toEqual([]);
		expect(findSharedInstructionDuplicates('- Do it now.')).toEqual([]);
	});
});

describe('authoredPromptError', () => {
	it('rejects the mechanical violations and nothing else', () => {
		expect(authoredPromptError('- Read `prd.md` first.')).toContain('prd.md');
		expect(
			authoredPromptError('- Wrap it in `withTransaction`.', { marketplaceReaching: true }),
		).toContain('withTransaction');
		// Length and vocabulary are judgement calls: they never block a write.
		expect(authoredPromptError(`- Generally, ${'word '.repeat(80)}`)).toBeNull();
	});

	it('returns null for a prompt written to the register', () => {
		expect(
			authoredPromptError('- **Post the active mention.** A passive one wakes nobody.', {
				marketplaceReaching: true,
			}),
		).toBeNull();
	});
});

describe('authoredPromptWarning', () => {
	it('advises on the judgement calls and names how to fix them', () => {
		const warning = authoredPromptWarning(`- Generally, ${'word '.repeat(80)}`);
		expect(warning).toContain('saved');
		expect(warning).toContain('update tool');
	});

	it('is null when the prompt is clean, so a caller can spread it away', () => {
		expect(
			authoredPromptWarning('- **Post the active mention.** A passive one wakes nobody.'),
		).toBeNull();
	});
});

/**
 * The wiring, not the rules. `checkAuthoredPrompt` is covered above; these
 * prove each surface actually calls it, which is the half that silently goes
 * missing when a new authoring surface is added (hence the Mirrored-surfaces
 * row: "A new surface that accepts an authored prompt -> its checkPromptStyle
 * call -> nothing - on you").
 */
describe('the authoring surfaces run the register', () => {
	let app: Hono<Env>;
	let db: Db;
	let token: string;
	let masterKeyManager: MasterKeyManager;
	let teamId: string;
	let projectSlug: string;
	let projectId: string;
	let captainId: string;
	let architectId: string;

	/** A prompt that keeps every required variable but breaks a mechanical rule. */
	const backtickedDoc = compliantPrompt('You are an Architect. Read `spec.md` before you start.');

	async function mcp(agentToken: string, name: string, args: Record<string, unknown>) {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				id: 1,
				params: { name, arguments: args },
			}),
		});
		const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
		return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
	}

	beforeAll(async () => {
		const ctx = await createTestApp();
		app = ctx.app;
		db = ctx.db;
		token = ctx.token;
		masterKeyManager = ctx.masterKeyManager;

		const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'App Team',
		).id;
		const teamRes = await createTestTeam(db, { name: 'Style Wiring Co', template_id: typeId });
		teamId = (await teamRes.json()).data.id;
		const proj = (await (await createTestProject(db, teamId, { name: 'Wiring' })).json()).data;
		projectSlug = proj.slug;
		projectId = proj.id;

		const agents = (
			await (
				await app.request(`/api/projects/${projectSlug}/agents`, { headers: authHeader(token) })
			).json()
		).data;
		captainId = agents.find((a: Record<string, unknown>) => a.slug === CAPTAIN_AGENT_SLUG).id;
		architectId = agents.find((a: Record<string, unknown>) => a.slug === 'architect').id;
	});

	afterAll(async () => {
		await safeClose(db);
	});

	it('update_agent_system_prompt rejects a style violation and names it', async () => {
		const { token: captainToken } = await mintAgentToken(
			db,
			masterKeyManager,
			captainId,
			teamId,
			null,
			{
				projectId,
			},
		);
		const result = await mcp(captainToken, 'update_agent_system_prompt', {
			project: projectSlug,
			agent_id: architectId,
			new_system_prompt: backtickedDoc,
			change_summary: 'should be rejected on style',
		});
		expect(typeof result.error).toBe('string');
		expect(result.error as string).toContain('spec.md');
	});

	it('the REST agent-create route rejects the same prompt', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Styled Worker', system_prompt: backtickedDoc }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error.message as string).toContain('spec.md');
	});

	it('accepts the same prompt once the reference is written bare', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: 'Bare Ref Worker',
				system_prompt: compliantPrompt('You are an Architect. Read spec.md before you start.'),
			}),
		});
		expect(res.status).toBe(201);
	});
});
