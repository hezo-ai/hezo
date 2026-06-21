import { ImageBuildStatus, type WsImageBuildMessage, WsMessageType, wsRoom } from '@hezo/shared';
import { logger } from '../logger';
import type { WebSocketManager } from './ws';

const log = logger.child('image-build-tracker');

export interface ImageBuildState {
	image: string;
	status: ImageBuildStatus;
	/** Best-effort completion estimate (0–100), derived from the step counter. */
	percent: number;
	step: number | null;
	totalSteps: number | null;
	/** The current build step's instruction, surfaced under the progress bar. */
	label: string | null;
}

export interface BuildProgress {
	step: number;
	totalSteps: number;
	label: string;
}

// Classic builder: `Step 5/14 : RUN apt-get update`.
const STEP_CLASSIC = /^Step (\d+)\/(\d+)\s*:\s*(.*)$/;
// BuildKit: `#8 [ 5/14] RUN apt-get update` or `=> [stage-1 5/14] ...`.
const STEP_BUILDKIT = /\[\s*(?:[\w-]+ )?(\d+)\/(\d+)\s*\]\s*(.*)$/;

/**
 * Extract `(step, totalSteps, label)` from a `docker build` log line, covering
 * both the classic builder's `Step N/M :` and BuildKit's `[ N/M]` formats.
 * Returns null for lines that carry no step counter.
 */
export function parseBuildProgress(line: string): BuildProgress | null {
	const m = STEP_CLASSIC.exec(line) ?? STEP_BUILDKIT.exec(line);
	if (!m) return null;
	const step = Number(m[1]);
	const totalSteps = Number(m[2]);
	if (!Number.isInteger(step) || !Number.isInteger(totalSteps) || totalSteps <= 0) return null;
	if (step < 0 || step > totalSteps) return null;
	return { step, totalSteps, label: (m[3] ?? '').trim() };
}

function percentFor(step: number, totalSteps: number): number {
	if (totalSteps <= 0) return 0;
	// Hold below 100 while building; `finish` is the only path to a full bar.
	return Math.max(0, Math.min(99, Math.round((step / totalSteps) * 100)));
}

/**
 * Tracks in-flight base-image builds and broadcasts their progress to the
 * single global `image-builds` room. Base images are shared across every
 * project, so build state lives here — keyed by image tag — independent of any
 * project's `container_status`. Mirrors {@link LogStreamBroker}'s replay model:
 * a client that subscribes mid-build is sent the current state immediately.
 */
export class ImageBuildTracker {
	private wsManager: WebSocketManager | null = null;
	private builds = new Map<string, ImageBuildState>();

	setWsManager(wsManager: WebSocketManager): void {
		this.wsManager = wsManager;
	}

	/** Mark a build as started (0%). Replaces any prior state for the image. */
	start(image: string): void {
		const state: ImageBuildState = {
			image,
			status: ImageBuildStatus.Building,
			percent: 0,
			step: null,
			totalSteps: null,
			label: null,
		};
		this.builds.set(image, state);
		this.broadcast(state);
	}

	/**
	 * Feed a build log line. Advances the bar only when the line carries a new
	 * step counter, so the dozens of trace lines per step don't spam the room.
	 */
	observe(image: string, line: string): void {
		const prev = this.builds.get(image);
		if (!prev) return; // only between start() and finish()/fail()
		const progress = parseBuildProgress(line);
		if (!progress) return;
		if (
			prev.step === progress.step &&
			prev.totalSteps === progress.totalSteps &&
			prev.label === progress.label
		) {
			return;
		}
		const next: ImageBuildState = {
			image,
			status: ImageBuildStatus.Building,
			percent: percentFor(progress.step, progress.totalSteps),
			step: progress.step,
			totalSteps: progress.totalSteps,
			label: progress.label || null,
		};
		this.builds.set(image, next);
		this.broadcast(next);
	}

	/** Terminal success: broadcast a full bar, then drop the state. */
	finish(image: string): void {
		const prev = this.builds.get(image);
		this.builds.delete(image);
		this.broadcast({
			image,
			status: ImageBuildStatus.Done,
			percent: 100,
			step: prev?.totalSteps ?? prev?.step ?? null,
			totalSteps: prev?.totalSteps ?? null,
			label: null,
		});
	}

	/** Terminal failure: broadcast error, then drop the state. */
	fail(image: string, error: string): void {
		const prev = this.builds.get(image);
		this.builds.delete(image);
		this.broadcast({
			image,
			status: ImageBuildStatus.Error,
			percent: prev?.percent ?? 0,
			step: prev?.step ?? null,
			totalSteps: prev?.totalSteps ?? null,
			label: error.slice(0, 200) || null,
		});
	}

	isBuilding(image: string): boolean {
		return this.builds.get(image)?.status === ImageBuildStatus.Building;
	}

	/** Replay current in-flight builds to a newly-subscribed socket. */
	replay(send: (payload: WsImageBuildMessage) => void): void {
		for (const state of this.builds.values()) {
			send({ type: WsMessageType.ImageBuild, ...state });
		}
	}

	private broadcast(state: ImageBuildState): void {
		log.debug(
			`${state.image} ${state.status} ${state.percent}%${state.label ? ` ${state.label}` : ''}`,
		);
		// A fresh object literal satisfies the open WsEvent transport shape.
		this.wsManager?.broadcast(wsRoom.imageBuilds(), { type: WsMessageType.ImageBuild, ...state });
	}
}

/**
 * Process-wide tracker singleton. Base-image builds are deduplicated globally
 * in `ensure-image.ts` (one build per tag regardless of which project triggered
 * it), so their progress must be tracked in one place too. Set once at startup.
 */
let sharedTracker: ImageBuildTracker | null = null;

export function setSharedImageBuildTracker(tracker: ImageBuildTracker | null): void {
	sharedTracker = tracker;
}

export function getSharedImageBuildTracker(): ImageBuildTracker | null {
	return sharedTracker;
}
