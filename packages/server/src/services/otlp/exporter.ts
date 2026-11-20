import type { HeartbeatRunStatus } from '@hezo/shared';
import { hostMatchesAllowedHosts } from '@hezo/shared';
import type { Logger } from '@hiddentao/logger';
import type { OtlpConfig } from '../../config/types';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Db } from '../../db/database';
import { trackBackground, waitForBackground } from '../../lib/background';
import { logger as rootLogger } from '../../logger';
import { HEZO_VERSION } from '../../version';
import { loadAllSecrets } from '../egress/substitution';
import { getOrCreateInstanceId } from '../telemetry';
import {
	type DropReason,
	isSampledRun,
	type MappedSpan,
	type MetricSample,
	mapRunFinishedMetrics,
	mapRunSpan,
	mapRunStartedMetric,
	type SpanNames,
	toUnixNano,
} from './mapping';

/**
 * Native OTLP/HTTP JSON export. One span per completed run plus a bounded metric
 * set, pushed to an operator's collector.
 *
 * This module is the only place the allowlist gate, the queue, the HTTP client,
 * the accumulators and the status live. Best effort throughout: no failure here
 * may take down a run, a request or the server.
 */

/** Records the observer hands to the exporter at run start. */
export interface RunStartRecord {
	runId: string;
	teamId: string;
	projectId: string;
	agentMemberId: string;
	taskId: string | null;
	triggerSource: string | null;
	/** ISO, when the observer saw the event. */
	receivedAt: string;
}

/** Records the observer builds from the finished row at completion. */
export interface RunFinishRecord {
	runId: string;
	teamId: string;
	projectId: string;
	agentMemberId: string;
	taskId: string | null;
	status: HeartbeatRunStatus;
	exitCode: number | null;
	/** Raw; the mapper decides whether it may leave. */
	errorText: string | null;
	startedAt: string;
	finishedAt: string;
	provider: string | null;
	model: string | null;
	tokens: {
		input: number;
		output: number;
		cacheRead: number | null;
		cacheCreation: number | null;
	};
	/** Summed across tool names, never the map. */
	toolCalls: number | null;
	stopReason: string | null;
	retryOfRunId: string | null;
	/** From the start receipt, when available. */
	triggerSource: string | null;
	/**
	 * Display names, populated by the observer only when `includeNames` is on.
	 * Absent otherwise, so no name reaches the mapper by default.
	 */
	names?: SpanNames;
}

export type OtlpStatus =
	| { state: 'disabled' }
	| { state: 'locked'; lastError: string | null }
	| { state: 'blocked'; reason: 'endpoint_not_allowed_by_secret' }
	| { state: 'ready'; lastFlushAt: string | null; lastError: string | null; dropped: number };

export interface OtlpExporter {
	emitRunStarted(run: RunStartRecord): void;
	emitRunFinished(run: RunFinishRecord): void;
	emitMetrics(sample: MetricSample): void;
	flush(timeoutMs: number): Promise<void>;
	stop(): Promise<void>;
	status(): OtlpStatus;
}

/**
 * The exporter object also exposes the allowlist to the gauge, which filters
 * its SQL by it. That is an internal addition, not part of {@link OtlpExporter}.
 */
export interface OtlpExporterHandle extends OtlpExporter {
	/** `null` means the wildcard (`projects: ['*']`). */
	allowedProjectIds(): readonly string[] | null;
}

/** The exact startup line the brief requires for this case. */
export const OTLP_DISABLED_LINE = 'disabled (endpoint set, exporter not enabled)';

/** The project allowlist gate. One definition, called from every export entry. */
export function isProjectAllowed(
	projects: readonly string[] | null,
	projectId: string | null,
): boolean {
	if (projectId === null) return false;
	if (projects === null) return true;
	return projects.includes(projectId);
}

interface QueueEntry {
	/** The record's own JSON, serialized once at enqueue. */
	payload: string;
	bytes: number;
	enqueuedAt: number;
}

interface SumAccumulator {
	attributes: Record<string, string | number>;
	value: number;
	startNanos: string;
}

interface HistogramAccumulator {
	attributes: Record<string, string | number>;
	count: number;
	sum: number;
	/** One per bucket: the twelve explicit bounds plus overflow. */
	buckets: number[];
	startNanos: string;
}

/** The duration histogram's explicit bounds, in milliseconds. */
const DURATION_BOUNDS = [
	500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000,
] as const;

const MAX_ACCUMULATOR_TUPLES = 10_000;
const MAX_QUEUE_AGE_MS = 300_000;
const FLUSH_INTERVAL_MS = 1000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const REPEAT_LOG_INTERVAL_MS = 300_000;

interface SendResult {
	ok: boolean;
	/** Retry the same batch: 429/502/503/504, network error, timeout, abort. */
	retryable: boolean;
	/** Honoured exactly as sent; absent becomes the computed backoff. */
	retryAfterMs?: number;
	error?: string;
}

interface CreateOtlpExporterOptions {
	config: OtlpConfig;
	masterKeyManager: MasterKeyManager;
	db: Db;
	dataDir: string;
	log?: Logger;
}

/**
 * Build the exporter. Disabled returns immediately with no vault read, no
 * instance id and no timer. Enabled resolves the header secret (if named) and
 * the endpoint host check before returning, so a named secret that cannot be
 * resolved is a startup error rather than a collector full of 401s.
 */
export async function createOtlpExporter(
	opts: CreateOtlpExporterOptions,
): Promise<OtlpExporterHandle> {
	const log = opts.log ?? rootLogger.child('otlp');
	const exporter = new NativeOtlpExporter({ ...opts, log });
	await exporter.initialize();
	return exporter;
}

class NativeOtlpExporter implements OtlpExporterHandle {
	private readonly config: OtlpConfig;
	private readonly masterKeyManager: MasterKeyManager;
	private readonly db: Db;
	private readonly dataDir: string;
	private readonly log: Logger;
	private readonly allowlist: string[] | null;

	private state: 'disabled' | 'locked' | 'blocked' | 'ready' = 'disabled';
	private lastFlushAt: string | null = null;
	private lastError: string | null = null;
	private droppedTotal = 0;
	private stopped = false;

	private endpoint = '';
	private endpointHost = '';
	private headerValue: string | null = null;

	private instanceId: string | null = null;
	private resourceJson = '';
	private scopeJson = '';

	private readonly spanQueue: QueueEntry[] = [];
	private readonly metricQueue: QueueEntry[] = [];
	private queuedBytes = 0;

	private readonly sums = new Map<string, Map<string, SumAccumulator>>();
	private readonly histogram = new Map<string, HistogramAccumulator>();
	private readonly knownProjects = new Map<string, string>();
	private readonly pendingTeams = new Map<string, Promise<string | null>>();

	private timer: ReturnType<typeof setInterval> | null = null;
	private pumping: Promise<void> | null = null;
	private inFlightAbort: AbortController | null = null;
	private retryAt = 0;
	private backoffAttempt = 0;
	private lastFailureLogAt = 0;
	private suppressedFailures = 0;
	private hadFailure = false;

	constructor(opts: CreateOtlpExporterOptions & { log: Logger }) {
		this.config = opts.config;
		this.masterKeyManager = opts.masterKeyManager;
		this.db = opts.db;
		this.dataDir = opts.dataDir;
		this.log = opts.log;
		this.allowlist = opts.config.projects.includes('*') ? null : [...opts.config.projects];
	}

	allowedProjectIds(): readonly string[] | null {
		return this.allowlist;
	}

	async initialize(): Promise<void> {
		if (!this.config.enabled) {
			this.state = 'disabled';
			this.log.debug(
				this.config.endpoint !== '' ? OTLP_DISABLED_LINE : 'disabled (exporter not enabled)',
			);
			return;
		}

		this.endpoint = this.config.endpoint.replace(/\/+$/, '');
		this.endpointHost = stripIpv6Brackets(new URL(this.endpoint).hostname);
		this.instanceId = await getOrCreateInstanceId(this.db, this.dataDir);
		this.resourceJson = JSON.stringify({
			attributes: [
				{ key: 'service.name', value: { stringValue: 'hezo' } },
				{ key: 'service.version', value: { stringValue: HEZO_VERSION } },
				{ key: 'service.instance.id', value: { stringValue: this.instanceId } },
			],
		});
		this.scopeJson = JSON.stringify({ name: 'hezo', version: HEZO_VERSION });

		// Registered before the boot resolution so an already-unlocked key also
		// reaches an exporter that starts locked; the handler ignores that
		// immediate call because there is nothing left to resolve.
		this.masterKeyManager.onUnlock(() => this.onUnlock());

		if (this.config.headersSecret !== undefined) {
			const keyState = this.masterKeyManager.getState();
			if (keyState === 'unset') {
				throw new Error(
					`otlp.headersSecret names "${this.config.headersSecret}", but this instance has no ` +
						'master key. A secret cannot exist without one; unlock or set up the instance, or ' +
						'remove otlp.headersSecret.',
				);
			}
			if (keyState === 'locked') {
				this.state = 'locked';
				this.log.warn(
					`locked: header secret "${this.config.headersSecret}" for ${this.endpointHost} resolves on unlock`,
				);
				return;
			}
			const resolution = await this.resolveSecret();
			if (resolution === 'missing') {
				throw new Error(
					`otlp.headersSecret names "${this.config.headersSecret}", which is not in the vault. ` +
						'Create the secret, or remove otlp.headersSecret to export unauthenticated.',
				);
			}
			if (resolution === 'blocked') {
				this.state = 'blocked';
				this.log.warn(
					`blocked: secret "${this.config.headersSecret}" does not allow host ${this.endpointHost}`,
				);
				return;
			}
		}

		this.startReady();
	}

	/** Resolve the named secret and check the endpoint host against its scope. */
	private async resolveSecret(): Promise<'ready' | 'blocked' | 'missing'> {
		const name = this.config.headersSecret;
		if (name === undefined) return 'ready';
		const secrets = await loadAllSecrets({ db: this.db, masterKeyManager: this.masterKeyManager });
		const secret = secrets.get(name);
		if (!secret) return 'missing';
		const allowed =
			secret.allowAllHosts || hostMatchesAllowedHosts(this.endpointHost, secret.allowedHosts);
		if (!allowed) return 'blocked';
		this.headerValue = secret.value;
		return 'ready';
	}

	private onUnlock(): void {
		if (this.state !== 'locked') return;
		trackBackground(
			(async () => {
				if (this.state !== 'locked') return;
				let resolution: 'ready' | 'blocked' | 'missing';
				try {
					resolution = await this.resolveSecret();
				} catch (err) {
					this.setError(`could not resolve the header secret: ${describeError(err)}`);
					this.log.error(
						`locked: could not resolve header secret "${this.config.headersSecret}" on unlock:`,
						err,
					);
					return;
				}
				if (resolution === 'missing') {
					this.setError(`secret "${this.config.headersSecret}" is not in the vault`);
					this.log.error(
						`locked: header secret "${this.config.headersSecret}" is not in the vault; ` +
							'export stays off until a restart fixes otlp.headersSecret',
					);
					return;
				}
				if (resolution === 'blocked') {
					this.state = 'blocked';
					this.log.warn(
						`blocked: secret "${this.config.headersSecret}" does not allow host ${this.endpointHost}`,
					);
					return;
				}
				this.startReady();
			})(),
		);
	}

	private startReady(): void {
		this.state = 'ready';
		const mode =
			this.allowlist === null
				? 'all projects'
				: `${this.allowlist.length} allowed project${this.allowlist.length === 1 ? '' : 's'}`;
		this.log.info(`ready: exporting to ${this.endpointHost} (${mode})`);
		if (this.timer === null) {
			this.timer = setInterval(() => {
				void this.pump(null).catch((err) => {
					this.setError(`flush failed: ${describeError(err)}`);
					this.recordDrop('export_error');
				});
			}, FLUSH_INTERVAL_MS);
			unrefTimer(this.timer);
		}
	}

	status(): OtlpStatus {
		switch (this.state) {
			case 'disabled':
				return { state: 'disabled' };
			case 'locked':
				return { state: 'locked', lastError: this.lastError };
			case 'blocked':
				return { state: 'blocked', reason: 'endpoint_not_allowed_by_secret' };
			case 'ready':
				return {
					state: 'ready',
					lastFlushAt: this.lastFlushAt,
					lastError: this.lastError,
					dropped: this.droppedTotal,
				};
		}
	}

	emitRunStarted(run: RunStartRecord): void {
		if (this.stopped) return;
		const unavailable = this.unavailableReason();
		if (unavailable !== null) {
			this.recordDrop(unavailable);
			return;
		}
		if (!this.isAllowed(run.projectId)) return;
		this.accumulateSample(mapRunStartedMetric(run));
	}

	emitRunFinished(run: RunFinishRecord): void {
		if (this.stopped) return;
		const unavailable = this.unavailableReason();
		if (unavailable !== null) {
			this.recordDrop(unavailable);
			return;
		}
		if (!this.isAllowed(run.projectId)) return;

		for (const sample of mapRunFinishedMetrics(run)) this.accumulateSample(sample);

		// Sampling applies to spans only: a sampled counter would disagree with
		// the database for no reason an operator could see.
		if (!isSampledRun(run.runId, this.config.sampleRatio)) return;
		const span = mapRunSpan(run, {
			includeNames: this.config.includeNames,
			includeErrorText: this.config.includeErrorText,
			names: run.names,
		});
		this.enqueueSpan(span);
	}

	emitMetrics(sample: MetricSample): void {
		if (this.stopped) return;
		if (sample.kind === 'dropped') {
			this.addDropReason(sample.dropReason, sample.value);
			return;
		}
		const unavailable = this.unavailableReason();
		if (unavailable !== null) {
			this.recordDrop(unavailable);
			return;
		}
		if (sample.kind === 'active' || sample.kind === 'uptime') {
			if (!this.isAllowed(sample.projectId)) return;
			// Neither query projects a team id; resolve it once per distinct
			// project and answer every later sample from the memo.
			trackBackground(
				(async () => {
					const teamId = await this.teamIdFor(sample.projectId);
					if (teamId === null) {
						this.recordDrop('unresolved_project');
						return;
					}
					if (sample.kind === 'active') {
						this.enqueueActiveGauge(sample.projectId, teamId, sample.value, sample.at);
					} else {
						this.addSum(
							'hezo.container.uptime',
							{
								'hezo.team.id': teamId,
								'hezo.project.id': sample.projectId,
								'hezo.container.end_reason': sample.endReason,
							},
							sample.value,
						);
					}
				})(),
			);
			return;
		}
		if (!this.isAllowed(sample.projectId)) return;
		this.accumulateSample(sample);
	}

	/** The reason a record cannot be buffered while the exporter is not ready. */
	private unavailableReason(): DropReason | null {
		if (this.state === 'ready') return null;
		if (this.state === 'locked') return 'missing_secret';
		return 'blocked';
	}

	private isAllowed(projectId: string | null): boolean {
		if (isProjectAllowed(this.allowlist, projectId)) return true;
		this.recordDrop('project_not_allowed');
		return false;
	}

	/** Add a metric sample to its cumulative accumulator (or, for dropped, count it). */
	private accumulateSample(sample: MetricSample): void {
		switch (sample.kind) {
			case 'run_started':
				this.addSum(
					'hezo.runs.started',
					{
						'hezo.team.id': sample.teamId,
						'hezo.project.id': sample.projectId,
						'hezo.agent.id': sample.agentMemberId,
						...(sample.triggerSource === null
							? {}
							: { 'hezo.run.trigger_source': sample.triggerSource }),
					},
					1,
				);
				return;
			case 'run_completed':
				this.addSum(
					'hezo.runs.completed',
					{
						'hezo.team.id': sample.teamId,
						'hezo.project.id': sample.projectId,
						'hezo.agent.id': sample.agentMemberId,
						'hezo.run.status': sample.status,
						'hezo.run.failure_class': sample.failureClass,
					},
					1,
				);
				return;
			case 'run_duration':
				this.addHistogram(
					{
						'hezo.team.id': sample.teamId,
						'hezo.project.id': sample.projectId,
						'hezo.agent.id': sample.agentMemberId,
						'hezo.run.status': sample.status,
					},
					sample.value,
				);
				return;
			case 'tokens':
				this.addSum(
					'hezo.tokens',
					{
						'hezo.team.id': sample.teamId,
						'hezo.project.id': sample.projectId,
						'hezo.agent.id': sample.agentMemberId,
						...(sample.provider === null ? {} : { 'hezo.provider': sample.provider }),
						...(sample.model === null ? {} : { 'hezo.model': sample.model }),
						'hezo.tokens.direction': sample.direction,
					},
					sample.value,
				);
				return;
			case 'active':
			case 'uptime':
				// Routed through the async team resolution in emitMetrics.
				return;
			case 'dropped':
				this.addDropReason(sample.dropReason, sample.value);
				return;
		}
	}

	private addSum(name: string, attributes: Record<string, string | number>, value: number): void {
		let map = this.sums.get(name);
		if (map === undefined) {
			map = new Map();
			this.sums.set(name, map);
		}
		const key = attributeKey(attributes);
		const existing = map.get(key);
		if (existing !== undefined) {
			existing.value += value;
			return;
		}
		if (map.size >= MAX_ACCUMULATOR_TUPLES) {
			this.recordDrop('cardinality_cap');
			return;
		}
		map.set(key, { attributes, value, startNanos: nowNanos() });
	}

	private addHistogram(attributes: Record<string, string | number>, value: number): void {
		const key = attributeKey(attributes);
		const existing = this.histogram.get(key);
		if (existing !== undefined) {
			existing.count += 1;
			existing.sum += value;
			existing.buckets[bucketIndex(value)] += 1;
			return;
		}
		if (this.histogram.size >= MAX_ACCUMULATOR_TUPLES) {
			this.recordDrop('cardinality_cap');
			return;
		}
		const buckets = new Array(DURATION_BOUNDS.length + 1).fill(0) as number[];
		buckets[bucketIndex(value)] += 1;
		this.histogram.set(key, {
			attributes,
			count: 1,
			sum: value,
			buckets,
			startNanos: nowNanos(),
		});
	}

	private recordDrop(reason: DropReason, count = 1): void {
		this.addDropReason(reason, count);
	}

	/**
	 * Every drop increments the closed-set counter. While the exporter is not
	 * ready the counter accumulates without being sent; it flushes once the
	 * exporter becomes ready, so the count survives the condition it describes.
	 */
	private addDropReason(reason: DropReason, count: number): void {
		if (count <= 0) return;
		this.droppedTotal += count;
		// Written directly rather than through `addSum`, whose cardinality guard
		// calls back into this method: the drop counter must be able to record the
		// cap it hit without re-entering the same guard forever.
		let map = this.sums.get('hezo.otlp.dropped');
		if (map === undefined) {
			map = new Map();
			this.sums.set('hezo.otlp.dropped', map);
		}
		const attributes = { 'hezo.otlp.drop_reason': reason };
		const key = attributeKey(attributes);
		const existing = map.get(key);
		if (existing !== undefined) {
			existing.value += count;
		} else if (map.size < MAX_ACCUMULATOR_TUPLES) {
			map.set(key, { attributes, value: count, startNanos: nowNanos() });
		}
		if (reason !== 'queue_full') this.log.debug(`dropped ${count} ${reason}`);
	}

	private async teamIdFor(projectId: string): Promise<string | null> {
		const cached = this.knownProjects.get(projectId);
		if (cached !== undefined) return cached;
		let pending = this.pendingTeams.get(projectId);
		if (pending === undefined) {
			pending = (async () => {
				try {
					const result = await this.db.query<{ team_id: string }>(
						'SELECT team_id FROM projects WHERE id = $1',
						[projectId],
					);
					const teamId = result.rows[0]?.team_id ?? null;
					if (teamId !== null) this.knownProjects.set(projectId, teamId);
					return teamId;
				} catch (err) {
					this.setError(`project lookup failed: ${describeError(err)}`);
					return null;
				}
			})().finally(() => {
				this.pendingTeams.delete(projectId);
			});
			this.pendingTeams.set(projectId, pending);
		}
		return pending;
	}

	// ------------------------------------------------------------------
	// Queue and transport
	// ------------------------------------------------------------------

	private enqueueSpan(span: MappedSpan): void {
		const payload = JSON.stringify(span);
		const entry: QueueEntry = {
			payload,
			bytes: Buffer.byteLength(payload, 'utf8'),
			enqueuedAt: Date.now(),
		};
		this.spanQueue.push(entry);
		this.queuedBytes += entry.bytes;
		this.enforceQueueBound();
		this.maybeTriggerFlush();
	}

	private enqueueActiveGauge(projectId: string, teamId: string, value: number, at: string): void {
		const point = {
			asInt: String(value),
			timeUnixNano: toUnixNano(at),
			attributes: [
				{ key: 'hezo.team.id', value: { stringValue: teamId } },
				{ key: 'hezo.project.id', value: { stringValue: projectId } },
			],
		};
		const payload = JSON.stringify(point);
		const entry: QueueEntry = {
			payload,
			bytes: Buffer.byteLength(payload, 'utf8'),
			enqueuedAt: Date.now(),
		};
		this.metricQueue.push(entry);
		this.queuedBytes += entry.bytes;
		this.enforceQueueBound();
		this.maybeTriggerFlush();
	}

	private enforceQueueBound(): void {
		while (this.queuedBytes > this.config.maxQueueBytes) {
			if (!this.dropOldest()) break;
		}
	}

	/** Drop the oldest record across both queues, counted `queue_full`. */
	private dropOldest(): boolean {
		const span = this.spanQueue[0];
		const metric = this.metricQueue[0];
		if (span === undefined && metric === undefined) return false;
		let entry: QueueEntry;
		if (span === undefined) {
			entry = this.metricQueue.shift() as QueueEntry;
		} else if (metric === undefined) {
			entry = this.spanQueue.shift() as QueueEntry;
		} else if (span.enqueuedAt <= metric.enqueuedAt) {
			entry = this.spanQueue.shift() as QueueEntry;
		} else {
			entry = this.metricQueue.shift() as QueueEntry;
		}
		this.queuedBytes -= entry.bytes;
		this.recordDrop('queue_full');
		const now = Date.now();
		if (now - this.lastFailureLogAt > REPEAT_LOG_INTERVAL_MS) {
			this.lastFailureLogAt = now;
			this.log.warn('queue full: dropping oldest export record(s)');
		}
		return true;
	}

	private maybeTriggerFlush(): void {
		const threshold = this.config.maxQueueBytes / 4;
		const queuedCount = this.spanQueue.length + this.metricQueue.length;
		if (this.queuedBytes >= threshold || queuedCount >= this.config.batchSize) {
			void this.pump(null).catch((err) => {
				this.setError(`flush failed: ${describeError(err)}`);
				this.recordDrop('export_error');
			});
		}
	}

	/** Drop records older than five minutes, counted `stale`. */
	private dropStale(): void {
		const cutoff = Date.now() - MAX_QUEUE_AGE_MS;
		for (const queue of [this.spanQueue, this.metricQueue]) {
			while (queue.length > 0 && (queue[0] as QueueEntry).enqueuedAt < cutoff) {
				const entry = queue.shift() as QueueEntry;
				this.queuedBytes -= entry.bytes;
				this.recordDrop('stale');
			}
		}
	}

	/**
	 * Single consumer. A timer tick and an enqueue-triggered flush can arrive
	 * together, so every send goes through one pump; a second caller waits for
	 * the current one rather than sending concurrently.
	 */
	private async pump(deadline: number | null): Promise<void> {
		while (this.pumping !== null) await this.pumping;
		if (this.stopped) return;
		this.pumping = this.pumpLoop(deadline);
		try {
			await this.pumping;
		} finally {
			this.pumping = null;
		}
	}

	private async pumpLoop(deadline: number | null): Promise<void> {
		if (this.state !== 'ready') return;
		if (Date.now() < this.retryAt) return;

		// Spans first, then metrics, as the brief orders them.
		while (this.spanQueue.length > 0) {
			if (this.pastDeadline(deadline)) return;
			this.dropStale();
			const batch = this.spanQueue.slice(0, this.config.batchSize);
			if (batch.length === 0) break;
			const body = this.spansBody(batch);
			const result = await this.post('/v1/traces', body, deadline);
			if (!this.handleSendResult(result, batch.length)) return;
			this.removeHead(this.spanQueue, batch);
		}

		let includeAccumulators = true;
		while (this.metricQueue.length > 0 || (includeAccumulators && this.hasAccumulators())) {
			if (this.pastDeadline(deadline)) return;
			this.dropStale();
			const batch = this.metricQueue.slice(0, this.config.batchSize);
			const body = this.metricsBody(batch, includeAccumulators);
			const result = await this.post('/v1/metrics', body, deadline);
			if (!this.handleSendResult(result, batch.length)) return;
			this.removeHead(this.metricQueue, batch);
			includeAccumulators = false;
			if (batch.length === 0) break;
		}
	}

	private pastDeadline(deadline: number | null): boolean {
		return deadline !== null && Date.now() >= deadline;
	}

	/**
	 * Apply a response: success resets backoff and records the flush time; a
	 * retryable failure sets backoff and returns false; a permanent rejection
	 * drops the batch, counts it and lets the caller continue with the next one.
	 */
	private handleSendResult(result: SendResult, batchLength: number): boolean {
		if (result.ok) {
			this.lastFlushAt = new Date().toISOString();
			this.retryAt = 0;
			this.backoffAttempt = 0;
			if (result.error !== undefined) {
				// A 2xx with `partialSuccess`: not retried, but the rejected count is
				// visible rather than swallowed.
				this.setError(result.error);
				return true;
			}
			if (this.hadFailure) {
				this.hadFailure = false;
				this.log.info('export recovered');
			}
			this.lastError = null;
			return true;
		}
		if (result.retryable) {
			this.applyBackoff(result.retryAfterMs);
			this.setError(result.error ?? 'request failed');
			this.logFailure(result.error ?? 'request failed');
			return false;
		}
		if (batchLength > 0) this.recordDrop('rejected', batchLength);
		this.setError(result.error ?? 'collector rejected the batch');
		this.logFailure(result.error ?? 'collector rejected the batch');
		this.retryAt = 0;
		this.backoffAttempt = 0;
		return true;
	}

	private applyBackoff(retryAfterMs: number | undefined): void {
		if (retryAfterMs !== undefined) {
			this.retryAt = Date.now() + retryAfterMs;
			return;
		}
		const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.backoffAttempt);
		this.backoffAttempt = Math.min(this.backoffAttempt + 1, 16);
		// Full jitter: a uniform delay between 0 and the current ceiling.
		this.retryAt = Date.now() + Math.random() * ceiling;
	}

	private logFailure(message: string): void {
		const now = Date.now();
		if (now - this.lastFailureLogAt > REPEAT_LOG_INTERVAL_MS) {
			const suffix = this.suppressedFailures > 0 ? ` (${this.suppressedFailures} suppressed)` : '';
			this.log.warn(`export failed: ${message}${suffix}`);
			this.lastFailureLogAt = now;
			this.suppressedFailures = 0;
		} else {
			this.suppressedFailures += 1;
		}
		this.hadFailure = true;
	}

	private setError(message: string): void {
		this.lastError = capText(message, 300);
	}

	private removeHead(queue: QueueEntry[], batch: QueueEntry[]): void {
		queue.splice(0, batch.length);
		for (const entry of batch) this.queuedBytes -= entry.bytes;
	}

	private hasAccumulators(): boolean {
		return this.sums.size > 0 || this.histogram.size > 0;
	}

	private spansBody(batch: QueueEntry[]): string {
		return (
			`{"resourceSpans":[{"resource":${this.resourceJson},"scopeSpans":[{"scope":${this.scopeJson},` +
			`"spans":[${batch.map((entry) => entry.payload).join(',')}]}]}]}`
		);
	}

	private metricsBody(batch: QueueEntry[], includeAccumulators: boolean): string {
		const metrics: string[] = [];
		if (includeAccumulators) {
			for (const [name, accs] of this.sums) {
				const dataPoints = [...accs.values()].map((acc) =>
					JSON.stringify({
						asInt: String(acc.value),
						startTimeUnixNano: acc.startNanos,
						timeUnixNano: toUnixNano(new Date().toISOString()),
						attributes: attributeList(acc.attributes),
					}),
				);
				metrics.push(
					`{"name":${JSON.stringify(name)},"unit":${JSON.stringify(sumUnit(name))},` +
						`"sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[${dataPoints.join(',')}]}}`,
				);
			}
			if (this.histogram.size > 0) {
				const dataPoints = [...this.histogram.values()].map((acc) =>
					JSON.stringify({
						startTimeUnixNano: acc.startNanos,
						timeUnixNano: toUnixNano(new Date().toISOString()),
						count: String(acc.count),
						sum: acc.sum,
						bucketCounts: acc.buckets.map(String),
						explicitBounds: [...DURATION_BOUNDS],
						attributes: attributeList(acc.attributes),
					}),
				);
				metrics.push(
					`{"name":"hezo.run.duration","unit":"ms","histogram":{"aggregationTemporality":2,` +
						`"dataPoints":[${dataPoints.join(',')}]}}`,
				);
			}
		}
		if (batch.length > 0) {
			metrics.push(
				`{"name":"hezo.runs.active","unit":"1","gauge":{"dataPoints":[${batch
					.map((entry) => entry.payload)
					.join(',')}]}}`,
			);
		}
		return `{"resourceMetrics":[{"resource":${this.resourceJson},"scopeMetrics":[{"scope":${this.scopeJson},"metrics":[${metrics.join(',')}]}]}]}`;
	}

	private async post(path: string, body: string, deadline: number | null): Promise<SendResult> {
		const controller = new AbortController();
		this.inFlightAbort = controller;
		const remaining =
			deadline === null
				? this.config.timeoutMs
				: Math.max(1, Math.min(this.config.timeoutMs, deadline - Date.now()));
		const timeout = setTimeout(() => controller.abort(), remaining);
		try {
			const response = await fetch(`${this.endpoint}${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'user-agent': `hezo/${HEZO_VERSION}`,
					...(this.headerValue === null ? {} : { authorization: this.headerValue }),
				},
				body,
				signal: controller.signal,
			});
			const text = await response.text();
			if (response.status >= 200 && response.status < 300) {
				const partial = parsePartialSuccess(text);
				if (partial !== null && partial.rejected > 0) {
					return {
						ok: true,
						retryable: false,
						error: `partial success: ${partial.rejected} ${partial.kind} rejected`,
					};
				}
				return { ok: true, retryable: false };
			}
			const retryable =
				response.status === 429 ||
				response.status === 502 ||
				response.status === 503 ||
				response.status === 504;
			return {
				ok: false,
				retryable,
				retryAfterMs: retryable ? parseRetryAfter(response.headers.get('retry-after')) : undefined,
				error: `status ${response.status}: ${this.scrub(text).slice(0, 200)}`,
			};
		} catch (err) {
			// Network error, timeout or abort: retry the same batch.
			return { ok: false, retryable: true, error: `export request failed: ${describeError(err)}` };
		} finally {
			clearTimeout(timeout);
			if (this.inFlightAbort === controller) this.inFlightAbort = null;
		}
	}

	private scrub(value: string): string {
		if (this.headerValue === null || this.headerValue === '') return value;
		return value.replaceAll(this.headerValue, '[redacted]');
	}

	/**
	 * Send what is queued within the budget, drop the remainder as
	 * `shutdown_timeout`, and resolve. Never rejects and never exceeds its budget.
	 */
	async flush(timeoutMs: number): Promise<void> {
		if (this.state !== 'ready') return;
		const deadline = Date.now() + timeoutMs;
		try {
			await waitForBackground();
			while (Date.now() < deadline) {
				await waitForBackground();
				const queued = this.spanQueue.length + this.metricQueue.length;
				if (queued === 0 && !this.hasAccumulators()) break;
				await this.pump(deadline);
				if (Date.now() < this.retryAt) break;
				if (this.spanQueue.length + this.metricQueue.length === 0) break;
			}
		} catch (err) {
			this.setError(`flush failed: ${describeError(err)}`);
			this.recordDrop('export_error');
		}
		const remaining = this.spanQueue.length + this.metricQueue.length;
		if (remaining > 0) {
			this.spanQueue.length = 0;
			this.metricQueue.length = 0;
			this.queuedBytes = 0;
			this.recordDrop('shutdown_timeout', remaining);
			this.log.warn(`shutdown flush timed out; dropped ${remaining} queued record(s)`);
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		// Settle any in-flight request with an abort; the queue is gone either way.
		this.inFlightAbort?.abort();
		try {
			await this.pumping;
		} catch {
			// stop() never rejects
		}
	}
}

function stripIpv6Brackets(host: string): string {
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function nowNanos(): string {
	return toUnixNano(new Date().toISOString());
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
	(timer as unknown as { unref?: () => void }).unref?.();
}

function capText(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** A deterministic key over an attribute object, whatever order it was built in. */
function attributeKey(attributes: Record<string, string | number>): string {
	return JSON.stringify(
		Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

function attributeList(
	attributes: Record<string, string | number>,
): Array<{ key: string; value: { stringValue: string } | { intValue: string } }> {
	return Object.entries(attributes).map(([key, value]) => ({
		key,
		value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value },
	}));
}

function sumUnit(name: string): string {
	return name === 'hezo.container.uptime' ? 's' : '1';
}

function bucketIndex(value: number): number {
	for (let i = 0; i < DURATION_BOUNDS.length; i += 1) {
		if (value <= (DURATION_BOUNDS[i] as number)) return i;
	}
	return DURATION_BOUNDS.length;
}

function parseRetryAfter(raw: string | null): number | undefined {
	if (raw === null) return undefined;
	const seconds = Number.parseInt(raw, 10);
	if (Number.isNaN(seconds) || seconds < 0) return undefined;
	return seconds * 1000;
}

interface PartialSuccess {
	rejected: number;
	kind: 'spans' | 'data points';
}

function parsePartialSuccess(body: string): PartialSuccess | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object') return null;
	const partial = (parsed as { partialSuccess?: unknown }).partialSuccess;
	if (partial === null || typeof partial !== 'object') return null;
	const record = partial as { rejectedSpans?: unknown; rejectedDataPoints?: unknown };
	const spans = Number(record.rejectedSpans ?? 0);
	if (Number.isFinite(spans) && spans > 0) return { rejected: spans, kind: 'spans' };
	const points = Number(record.rejectedDataPoints ?? 0);
	if (Number.isFinite(points) && points > 0) return { rejected: points, kind: 'data points' };
	return null;
}
