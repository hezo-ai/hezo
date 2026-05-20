import type { PGlite } from '@electric-sql/pglite';
import { IssueStatus, WakeupSource, WakeupStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	hasOpenBlockers,
	shouldDeferWakeupForBlockers,
	wakeIfReady,
	wouldCreateCycle,
} from '../../lib/dependencies';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let db: PGlite;
let app: Hono<Env>;
let token: string;
let teamId: string;
let projectId: string;
let researcherId: string;
let productLeadId: string;
let architectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	app = ctx.app;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const teamTemplateId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'Startup',
	).id;

	const teamRes = await app.request('/api/teams', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Dep Gate Co', template_id: teamTemplateId }),
	});
	teamId = (await teamRes.json()).data.id;

	const projectRes = await app.request(`/api/teams/${teamId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Gate Project', description: 'Test project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentsRes = await app.request(`/api/teams/${teamId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	researcherId = agents.find((a) => a.slug === 'researcher')!.id;
	productLeadId = agents.find((a) => a.slug === 'product-lead')!.id;
	architectId = agents.find((a) => a.slug === 'architect')!.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createIssue(
	title: string,
	assigneeId: string,
	blockedBy?: string[],
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/teams/${teamId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title,
			assignee_id: assigneeId,
			...(blockedBy ? { blocked_by_issue_ids: blockedBy } : {}),
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function setStatus(issueId: string, status: string): Promise<void> {
	const res = await app.request(`/api/teams/${teamId}/issues/${issueId}`, {
		method: 'PATCH',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ status }),
	});
	expect(res.status).toBe(200);
}

async function getWakeupForIssue(
	memberId: string,
	issueId: string,
): Promise<{ status: string; payload: Record<string, unknown> } | null> {
	const r = await db.query<{ status: string; payload: Record<string, unknown> }>(
		`SELECT status::text AS status, payload
		 FROM agent_wakeup_requests
		 WHERE member_id = $1 AND payload->>'issue_id' = $2
		 ORDER BY created_at DESC LIMIT 1`,
		[memberId, issueId],
	);
	return r.rows[0] ?? null;
}

describe('dependency gate — hasOpenBlockers / cycles', () => {
	it('reports no blockers for a fresh issue', async () => {
		const a = await createIssue('A solo', researcherId);
		expect(await hasOpenBlockers(db, a.id)).toBe(false);
	});

	it('reports blocked while upstream is open and unblocked once terminal', async () => {
		const upstream = await createIssue('Upstream', researcherId);
		const downstream = await createIssue('Downstream', productLeadId, [upstream.identifier]);

		expect(await hasOpenBlockers(db, downstream.id)).toBe(true);

		await setStatus(upstream.id, IssueStatus.InProgress);
		expect(await hasOpenBlockers(db, downstream.id)).toBe(true);

		await setStatus(upstream.id, IssueStatus.Done);
		expect(await hasOpenBlockers(db, downstream.id)).toBe(false);
	});

	it('rejects direct self-cycles and reachable-loop cycles', async () => {
		const a = await createIssue('Cycle A', researcherId);
		const b = await createIssue('Cycle B', productLeadId, [a.identifier]);
		const c = await createIssue('Cycle C', architectId, [b.identifier]);

		expect(await wouldCreateCycle(db, a.id, a.id)).toBe(true);
		expect(await wouldCreateCycle(db, a.id, c.id)).toBe(true);
		expect(await wouldCreateCycle(db, a.id, b.id)).toBe(true);
		expect(await wouldCreateCycle(db, b.id, a.id)).toBe(false);
	});

	it('createIssue rejects blocked_by entries that form a cycle', async () => {
		const a = await createIssue('cycle-create A', researcherId);
		const b = await createIssue('cycle-create B', productLeadId, [a.identifier]);

		const res = await app.request(`/api/teams/${teamId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'closes the loop',
				assignee_id: architectId,
				blocked_by_issue_ids: [b.identifier],
			}),
		});
		expect(res.status).toBe(201);
		const c = (await res.json()).data as { id: string };

		const aBlockedByC = await app.request(`/api/teams/${teamId}/issues/${a.id}/dependencies`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ blocked_by_issue_id: c.id }),
		});
		expect(aBlockedByC.status).toBe(400);
	});
});

describe('dependency gate — wakeup deferral and reverse trigger', () => {
	it('defers an assignment wakeup whose target has open blockers', async () => {
		const r = await createIssue('research', researcherId);
		const p = await createIssue('prd', productLeadId, [r.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		const pWakeup = await getWakeupForIssue(productLeadId, p.id);
		expect(pWakeup).not.toBeNull();

		const decision = await shouldDeferWakeupForBlockers(db, WakeupSource.Assignment, p.id);
		expect(decision).toBe(true);

		const upstreamDecision = await shouldDeferWakeupForBlockers(db, WakeupSource.Assignment, r.id);
		expect(upstreamDecision).toBe(false);
	});

	it('lets mention wakeups bypass the gate even on a blocked ticket', async () => {
		const r = await createIssue('research-bypass', researcherId);
		const p = await createIssue('prd-bypass', productLeadId, [r.identifier]);

		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Mention, p.id)).toBe(false);
		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Comment, p.id)).toBe(false);
		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Reply, p.id)).toBe(false);
		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Automation, p.id)).toBe(false);
	});

	it('does not defer wakeups on terminal-status tickets', async () => {
		const r = await createIssue('research-done', researcherId);
		const p = await createIssue('prd-done', productLeadId, [r.identifier]);
		await setStatus(p.id, IssueStatus.Done);
		expect(await shouldDeferWakeupForBlockers(db, WakeupSource.Assignment, p.id)).toBe(false);
	});

	it('flips deferred wakeup to queued when blocker closes', async () => {
		const r = await createIssue('research-chain', researcherId);
		const p = await createIssue('prd-chain', productLeadId, [r.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		const wakeup = await getWakeupForIssue(productLeadId, p.id);
		expect(wakeup).not.toBeNull();

		await db.query(
			`UPDATE agent_wakeup_requests
			 SET status = $1::wakeup_status, payload = payload || '{"reason":"blocked"}'::jsonb
			 WHERE member_id = $2 AND payload->>'issue_id' = $3`,
			[WakeupStatus.Deferred, productLeadId, p.id],
		);

		await setStatus(r.id, IssueStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		const after = await getWakeupForIssue(productLeadId, p.id);
		expect(after?.status).toBe(WakeupStatus.Queued);
	});

	it('cascades through a two-step chain', async () => {
		const r = await createIssue('chain2-r', researcherId);
		const p = await createIssue('chain2-p', productLeadId, [r.identifier]);
		const s = await createIssue('chain2-s', architectId, [p.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		for (const [member, issue] of [
			[productLeadId, p.id],
			[architectId, s.id],
		] as const) {
			await db.query(
				`UPDATE agent_wakeup_requests
				 SET status = $1::wakeup_status, payload = payload || '{"reason":"blocked"}'::jsonb
				 WHERE member_id = $2 AND payload->>'issue_id' = $3`,
				[WakeupStatus.Deferred, member, issue],
			);
		}

		await setStatus(r.id, IssueStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		const afterFirst = await getWakeupForIssue(architectId, s.id);
		expect(afterFirst?.status).toBe(WakeupStatus.Deferred);

		await setStatus(p.id, IssueStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		const afterSecond = await getWakeupForIssue(architectId, s.id);
		expect(afterSecond?.status).toBe(WakeupStatus.Queued);
	});

	it('unblocks when a dependency edge is removed via the REST endpoint', async () => {
		const r = await createIssue('edge-r', researcherId);
		const p = await createIssue('edge-p', productLeadId, [r.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		await db.query(
			`UPDATE agent_wakeup_requests
			 SET status = $1::wakeup_status, payload = payload || '{"reason":"blocked"}'::jsonb
			 WHERE member_id = $2 AND payload->>'issue_id' = $3`,
			[WakeupStatus.Deferred, productLeadId, p.id],
		);

		const depsRes = await app.request(`/api/teams/${teamId}/issues/${p.id}/dependencies`, {
			headers: authHeader(token),
		});
		const deps = (await depsRes.json()).data as Array<{ id: string }>;
		expect(deps.length).toBe(1);

		const delRes = await app.request(
			`/api/teams/${teamId}/issues/${p.id}/dependencies/${deps[0].id}`,
			{ method: 'DELETE', headers: authHeader(token) },
		);
		expect(delRes.status).toBe(200);

		const after = await getWakeupForIssue(productLeadId, p.id);
		expect(after?.status).toBe(WakeupStatus.Queued);
	});

	it('wakeIfReady creates a fresh assignment wakeup when none is deferred', async () => {
		const r = await createIssue('fresh-r', researcherId);
		const p = await createIssue('fresh-p', productLeadId, [r.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [productLeadId]);

		await setStatus(r.id, IssueStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		const after = await getWakeupForIssue(productLeadId, p.id);
		expect(after).not.toBeNull();
		expect(after?.status).toBe(WakeupStatus.Queued);
	});

	it('wakeIfReady is a no-op when blockers remain', async () => {
		const r1 = await createIssue('twoblock-r1', researcherId);
		const r2 = await createIssue('twoblock-r2', researcherId);
		const p = await createIssue('twoblock-p', productLeadId, [r1.identifier, r2.identifier]);

		await new Promise((res) => setTimeout(res, 50));
		await db.query('DELETE FROM agent_wakeup_requests WHERE member_id = $1', [productLeadId]);

		await setStatus(r1.id, IssueStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		await wakeIfReady(db, p.id);
		const after = await getWakeupForIssue(productLeadId, p.id);
		expect(after).toBeNull();
	});
});

async function getIssueStatus(issueId: string): Promise<string> {
	const r = await db.query<{ status: string }>('SELECT status FROM issues WHERE id = $1', [
		issueId,
	]);
	return r.rows[0]?.status ?? '';
}

async function addDependency(issueId: string, blockerIdentifier: string): Promise<{ id: string }> {
	const res = await app.request(`/api/teams/${teamId}/issues/${issueId}/dependencies`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ blocked_by_issue_id: blockerIdentifier }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).data;
}

async function deleteDependency(issueId: string, depId: string): Promise<void> {
	const res = await app.request(`/api/teams/${teamId}/issues/${issueId}/dependencies/${depId}`, {
		method: 'DELETE',
		headers: authHeader(token),
	});
	expect(res.status).toBe(200);
}

describe('blocked-status invariant', () => {
	it('flips backlog to blocked when a dependency is added', async () => {
		const upstream = await createIssue('inv-up', researcherId);
		const downstream = await createIssue('inv-down', productLeadId);
		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Backlog);

		await addDependency(downstream.id, upstream.identifier);

		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Blocked);
	});

	it('does not flip when the new blocker is already terminal', async () => {
		const upstream = await createIssue('inv-up-done', researcherId);
		await setStatus(upstream.id, IssueStatus.Done);
		const downstream = await createIssue('inv-down-done-up', productLeadId);

		await addDependency(downstream.id, upstream.identifier);

		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Backlog);
	});

	it('flips blocked back to backlog when the last open dependency is removed', async () => {
		const upstream = await createIssue('inv-remove-up', researcherId);
		const downstream = await createIssue('inv-remove-down', productLeadId);
		const dep = await addDependency(downstream.id, upstream.identifier);
		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Blocked);

		await deleteDependency(downstream.id, dep.id);

		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Backlog);
	});

	it('stays blocked when one of several dependencies is removed', async () => {
		const u1 = await createIssue('inv-multi-1', researcherId);
		const u2 = await createIssue('inv-multi-2', researcherId);
		const down = await createIssue('inv-multi-down', productLeadId);
		const d1 = await addDependency(down.id, u1.identifier);
		await addDependency(down.id, u2.identifier);
		expect(await getIssueStatus(down.id)).toBe(IssueStatus.Blocked);

		await deleteDependency(down.id, d1.id);

		expect(await getIssueStatus(down.id)).toBe(IssueStatus.Blocked);
	});

	it('coerces a PATCH to in_progress to blocked when open blockers exist', async () => {
		const upstream = await createIssue('inv-coerce-up', researcherId);
		const downstream = await createIssue('inv-coerce-down', productLeadId);
		await addDependency(downstream.id, upstream.identifier);

		await setStatus(downstream.id, IssueStatus.InProgress);

		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Blocked);
	});

	it('coerces a PATCH to blocked into backlog when no blockers exist', async () => {
		const issue = await createIssue('inv-coerce-blocked', productLeadId);

		await setStatus(issue.id, IssueStatus.Blocked);

		expect(await getIssueStatus(issue.id)).toBe(IssueStatus.Backlog);
	});

	it('flips downstream blocked to backlog when the upstream blocker hits done', async () => {
		const upstream = await createIssue('inv-up-flip', researcherId);
		const downstream = await createIssue('inv-down-flip', productLeadId);
		await addDependency(downstream.id, upstream.identifier);
		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Blocked);

		await setStatus(upstream.id, IssueStatus.Done);
		await new Promise((res) => setTimeout(res, 100));

		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Backlog);
	});

	it('flips downstream back to blocked when an upstream leaves terminal', async () => {
		const upstream = await createIssue('inv-leave-up', researcherId);
		const downstream = await createIssue('inv-leave-down', productLeadId);
		await addDependency(downstream.id, upstream.identifier);
		await setStatus(upstream.id, IssueStatus.Done);
		await new Promise((res) => setTimeout(res, 100));
		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Backlog);

		await setStatus(upstream.id, IssueStatus.InProgress);
		await new Promise((res) => setTimeout(res, 100));

		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Blocked);
	});

	it('never coerces an issue whose status is already terminal', async () => {
		const upstream = await createIssue('inv-term-up', researcherId);
		const downstream = await createIssue('inv-term-down', productLeadId);
		await setStatus(downstream.id, IssueStatus.Cancelled);

		await addDependency(downstream.id, upstream.identifier);

		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Cancelled);
	});

	it('records a status_change activity event with the derived target', async () => {
		const upstream = await createIssue('inv-event-up', researcherId);
		const downstream = await createIssue('inv-event-down', productLeadId);
		await addDependency(downstream.id, upstream.identifier);

		const commentsRes = await app.request(`/api/teams/${teamId}/issues/${downstream.id}/comments`, {
			headers: authHeader(token),
		});
		const comments = (await commentsRes.json()).data as Array<{
			content_type: string;
			content: { kind?: string; from?: string; to?: string };
		}>;
		const ev = comments.find(
			(c) => c.content_type === 'system' && c.content?.kind === 'status_change',
		);
		expect(ev?.content.from).toBe(IssueStatus.Backlog);
		expect(ev?.content.to).toBe(IssueStatus.Blocked);
	});

	it('creates an issue directly as blocked when blocked_by_issue_ids is provided', async () => {
		const upstream = await createIssue('inv-init-up', researcherId);
		const downstream = await createIssue('inv-init-down', productLeadId, [upstream.identifier]);

		expect(await getIssueStatus(downstream.id)).toBe(IssueStatus.Blocked);
	});
});
