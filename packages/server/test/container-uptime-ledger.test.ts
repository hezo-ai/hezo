/**
 * The container-hours ledger: what the pool's state transitions write, and what
 * the aggregation reads back.
 *
 * Every case here is one that would silently mis-bill rather than fail loudly -
 * a double-open billing the same minutes twice, a resume reopening a closed
 * stretch instead of starting a new one, a month-boundary interval landing whole
 * in the wrong month. None of them throws; they all just produce a wrong number.
 */

import { ContainerUptimeEndReason, HoursBucket } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import {
	containerHoursByProject,
	containerHoursSeries,
	containerHoursTotals,
	monthToDateContainerSeconds,
} from '../src/services/container-hours';
import {
	removePoolMember,
	setPoolMemberChatReservation,
	setPoolMemberState,
	upsertPoolMember,
} from '../src/services/sandbox/pool-db';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestTeam, projectSlugForTeamSlug } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectId: string;
let projectSlug: string;
let otherProjectId: string;

interface IntervalRow {
	container_id: string;
	started_at: string;
	ended_at: string | null;
	end_reason: string | null;
	reserved_for_chat: boolean;
	backend: string;
	memory_bytes: string | number | null;
	project_id: string | null;
}

async function intervals(containerId: string): Promise<IntervalRow[]> {
	const res = await db.query<IntervalRow>(
		// `::text` on both timestamps: PGlite hands a timestamptz back as a JS Date,
		// so two reads of one unchanged row are distinct objects and `toBe` fails on
		// identity rather than on value.
		`SELECT container_id, started_at::text, ended_at::text, end_reason, reserved_for_chat,
		        backend, memory_bytes, project_id
		   FROM container_uptime_entries WHERE container_id = $1 ORDER BY started_at`,
		[containerId],
	);
	return res.rows;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const teamRes = await createTestTeam(db, { name: 'Uptime Co' });
	const teamSlug = (await teamRes.json()).data.slug;
	projectSlug = await projectSlugForTeamSlug(db, teamSlug);
	const proj = await db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
		projectSlug,
	]);
	projectId = proj.rows[0].id;

	const otherRes = await createTestTeam(db, { name: 'Uptime Neighbour' });
	const otherSlug = await projectSlugForTeamSlug(db, (await otherRes.json()).data.slug);
	const other = await db.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
		otherSlug,
	]);
	otherProjectId = other.rows[0].id;
});

beforeEach(async () => {
	// Each case owns the whole ledger: the aggregations are instance-wide by
	// design, so a row left behind by a neighbour shows up in someone else's sum.
	await db.query('DELETE FROM container_uptime_entries');
	await db.query('DELETE FROM container_pool_members');
});

afterAll(async () => {
	await safeClose(db);
});

describe('the ledger follows the pool through a container lifetime', () => {
	it('opens on the creating upsert and does not open again when the member goes idle', async () => {
		await upsertPoolMember(db, projectId, 'c-life', 'creating', {
			diskGb: 5,
			memoryBytes: 2 * 1024 ** 3,
		});
		await upsertPoolMember(db, projectId, 'c-life', 'idle', {
			diskGb: 5,
			memoryBytes: 2 * 1024 ** 3,
		});

		const rows = await intervals('c-life');
		// One row, not two: provisioning legitimately upserts twice, and billing the
		// build phase separately from the ready phase would double-count it.
		expect(rows).toHaveLength(1);
		expect(rows[0].ended_at).toBeNull();
		// The shape rides along from the member row, so an hour can be re-costed later.
		expect(Number(rows[0].memory_bytes)).toBe(2 * 1024 ** 3);
		expect(rows[0].project_id).toBe(projectId);
	});

	it('leaves the open interval alone while a run claims and releases the container', async () => {
		await upsertPoolMember(db, projectId, 'c-busy', 'idle', { memoryBytes: 2 * 1024 ** 3 });
		await setPoolMemberState(db, 'c-busy', 'busy');
		await setPoolMemberState(db, 'c-busy', 'idle');

		// idle -> busy -> idle never stops the container, so it is one billed stretch.
		const rows = await intervals('c-busy');
		expect(rows).toHaveLength(1);
		expect(rows[0].ended_at).toBeNull();
	});

	it('a suspend then resume is two stretches, not one reopened', async () => {
		await upsertPoolMember(db, projectId, 'c-cycle', 'idle', { memoryBytes: 2 * 1024 ** 3 });
		await setPoolMemberState(db, 'c-cycle', 'suspended');
		await setPoolMemberState(db, 'c-cycle', 'idle');

		const rows = await intervals('c-cycle');
		expect(rows).toHaveLength(2);
		// The first closed and stays closed - the gap between them is a stopped
		// sandbox, which bills reserved disk and no compute.
		expect(rows[0].ended_at).not.toBeNull();
		expect(rows[0].end_reason).toBe(ContainerUptimeEndReason.Stopped);
		expect(rows[1].ended_at).toBeNull();
	});

	it('closing twice does not move the first close or open a second interval', async () => {
		await upsertPoolMember(db, projectId, 'c-twice', 'idle', {});
		await setPoolMemberState(db, 'c-twice', 'suspended');
		const first = (await intervals('c-twice'))[0].ended_at;

		await setPoolMemberState(db, 'c-twice', 'suspended');
		await upsertPoolMember(db, projectId, 'c-twice', 'suspended');

		const rows = await intervals('c-twice');
		expect(rows).toHaveLength(1);
		expect(rows[0].ended_at).toBe(first);
	});

	it('records why the stretch ended, so an eviction is distinguishable from a stop', async () => {
		await upsertPoolMember(db, projectId, 'c-evicted', 'idle', {});
		await setPoolMemberState(db, 'c-evicted', 'suspended', ContainerUptimeEndReason.Suspended);
		expect((await intervals('c-evicted'))[0].end_reason).toBe(ContainerUptimeEndReason.Suspended);

		await upsertPoolMember(db, projectId, 'c-faulted', 'idle', {});
		await setPoolMemberState(db, 'c-faulted', 'error');
		// Nobody asked for this stop, so it reads as reconciled rather than stopped.
		expect((await intervals('c-faulted'))[0].end_reason).toBe(ContainerUptimeEndReason.Reconciled);
	});

	it('closes on removal, and the row outlives the member it described', async () => {
		await upsertPoolMember(db, projectId, 'c-gone', 'idle', {});
		await removePoolMember(db, 'c-gone');

		const rows = await intervals('c-gone');
		expect(rows).toHaveLength(1);
		expect(rows[0].end_reason).toBe(ContainerUptimeEndReason.Destroyed);
		expect(rows[0].ended_at).not.toBeNull();
		const member = await db.query('SELECT 1 FROM container_pool_members WHERE container_id = $1', [
			'c-gone',
		]);
		expect(member.rows).toHaveLength(0);
	});

	it('carries the chat pin onto the stretch that is already running', async () => {
		// The chat claims a container that already exists, so the pin lands after
		// the interval opened. Without this the whole session bills as task time.
		await upsertPoolMember(db, projectId, 'c-chat', 'idle', {});
		expect((await intervals('c-chat'))[0].reserved_for_chat).toBe(false);

		await setPoolMemberChatReservation(db, 'c-chat', true);
		expect((await intervals('c-chat'))[0].reserved_for_chat).toBe(true);
	});

	it('opens nothing for a container the pool does not know', async () => {
		await setPoolMemberState(db, 'c-unknown', 'idle');
		expect(await intervals('c-unknown')).toHaveLength(0);
	});
});

describe('aggregation', () => {
	it('splits an interval across the buckets it spans instead of banking it at the start', async () => {
		// Exactly one hour either side of midnight tonight. The naive
		// attribute-by-start answer banks all two hours in yesterday's bucket.
		await db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, started_at, ended_at, backend)
			 VALUES ($1, 'c-span',
			         date_trunc('day', now() AT TIME ZONE 'UTC') - interval '1 hour',
			         date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 hour',
			         'docker')`,
			[projectId],
		);

		const series = await containerHoursSeries(db, HoursBucket.Day, projectId);
		const today = new Date().toISOString().slice(0, 10);
		const todayRow = series.find((b) => b.bucket === today);
		const yesterdayRow = series.find((b) => b.bucket !== today && b.seconds > 0);

		expect(todayRow?.seconds).toBe(3600);
		expect(yesterdayRow?.seconds).toBe(3600);
	});

	it('sums concurrent containers rather than merging them', async () => {
		// Two containers up for the same hour is two container-hours - which is
		// exactly what a provider bills, and exactly where per-agent run hours go
		// wrong by merging runs that shared one container.
		for (const id of ['c-par-a', 'c-par-b']) {
			await db.query(
				`INSERT INTO container_uptime_entries (project_id, container_id, started_at, ended_at, backend)
				 VALUES ($1, $2, now() - interval '1 hour', now(), 'docker')`,
				[projectId, id],
			);
		}
		const totals = await containerHoursTotals(db, projectId);
		expect(totals.month_seconds).toBe(2 * 3600);
	});

	it('bills an open interval up to now rather than counting it as zero', async () => {
		await db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, started_at, backend)
			 VALUES ($1, 'c-open', now() - interval '30 minutes', 'docker')`,
			[projectId],
		);
		const totals = await containerHoursTotals(db, projectId);
		expect(totals.month_seconds).toBeGreaterThanOrEqual(29 * 60);
		expect(totals.month_seconds).toBeLessThanOrEqual(31 * 60);
		expect(totals.open_intervals).toBe(1);
	});

	it('reports chat hours inside the total, not beside it', async () => {
		await db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, started_at, ended_at, reserved_for_chat, backend)
			 VALUES ($1, 'c-chat-h', now() - interval '1 hour', now(), true, 'docker'),
			        ($1, 'c-task-h', now() - interval '1 hour', now(), false, 'docker')`,
			[projectId],
		);
		const totals = await containerHoursTotals(db, projectId);
		expect(totals.month_seconds).toBe(2 * 3600);
		expect(totals.month_chat_seconds).toBe(3600);
	});

	it('scopes a project read to that project and keeps the instance read whole', async () => {
		await db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, started_at, ended_at, backend)
			 VALUES ($1, 'c-mine', now() - interval '1 hour', now(), 'docker'),
			        ($2, 'c-theirs', now() - interval '2 hours', now(), 'docker')`,
			[projectId, otherProjectId],
		);
		expect((await containerHoursTotals(db, projectId)).month_seconds).toBe(3600);
		expect((await containerHoursTotals(db, null)).month_seconds).toBe(3 * 3600);
	});

	it("keeps a deleted project's hours under one heading rather than dropping them", async () => {
		await db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, started_at, ended_at, backend)
			 VALUES (NULL, 'c-orphan', now() - interval '1 hour', now(), 'docker')`,
		);
		const byProject = await containerHoursByProject(db, HoursBucket.Day);
		const orphan = byProject.find((r) => r.project_id === null);
		expect(orphan?.project_name).toBe('Deleted projects');
		expect(orphan?.seconds).toBe(3600);
	});

	it('counts only the part of an interval that falls inside this month', async () => {
		// Straddles the month boundary. The month-to-date figure is what the hours
		// cap is enforced against, so banking the whole interval would cut an
		// instance off partway through its first day.
		await db.query(
			`INSERT INTO container_uptime_entries (project_id, container_id, started_at, ended_at, backend)
			 VALUES ($1, 'c-month',
			         date_trunc('month', now() AT TIME ZONE 'UTC') - interval '2 hours',
			         date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 hour',
			         'docker')`,
			[projectId],
		);
		expect(await monthToDateContainerSeconds(db)).toBe(3600);
	});

	it('emits every bucket in the window, including the quiet ones', async () => {
		const series = await containerHoursSeries(db, HoursBucket.Day, projectId);
		expect(series).toHaveLength(30);
		expect(series.every((b) => b.seconds === 0)).toBe(true);
	});
});

describe('GET /container-hours', () => {
	it('rejects a bucket outside the allowlist', async () => {
		const res = await app.request('/api/container-hours?bucket=century', {
			headers: authHeader(token),
		});
		expect(res.status).toBe(400);
	});

	it('serves the instance series with its cap', async () => {
		const res = await app.request('/api/container-hours', { headers: authHeader(token) });
		expect(res.status).toBe(200);
		const data = (await res.json()).data as {
			bucket: string;
			monthly_hours: number;
			metered: boolean;
			buckets: unknown[];
		};
		expect(data.bucket).toBe('day');
		// No cap by default - a self-hoster on a local daemon is metering nothing.
		expect(data.monthly_hours).toBe(0);
		expect(data.metered).toBe(false);
		expect(data.buckets).toHaveLength(30);
	});

	it('round-trips the monthly cap', async () => {
		const patch = await app.request('/api/container-hours', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ monthly_hours: 250 }),
		});
		expect(patch.status).toBe(200);

		const res = await app.request('/api/container-hours', { headers: authHeader(token) });
		expect(((await res.json()).data as { monthly_hours: number }).monthly_hours).toBe(250);

		const bad = await app.request('/api/container-hours', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ monthly_hours: -5 }),
		});
		expect(bad.status).toBe(400);

		await app.request('/api/container-hours', {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ monthly_hours: 0 }),
		});
	});

	it('serves the per-project series', async () => {
		const res = await app.request(`/api/projects/${projectSlug}/container-hours?bucket=week`, {
			headers: authHeader(token),
		});
		expect(res.status).toBe(200);
		const data = (await res.json()).data as { bucket: string; buckets: unknown[] };
		expect(data.bucket).toBe('week');
		expect(data.buckets).toHaveLength(12);
	});
});
