import { ContainerStatus } from '@hezo/shared';
import { useImageBuild } from './use-image-build';
import type { Project } from './use-projects';

/**
 * Normalised health of a project's container, derived from its stored status
 * plus any in-flight base-image build. A single source of truth shared by the
 * container status banner, the CEO chat, and the create-project gate so they
 * never disagree about whether a container is usable.
 *
 * `stopped` is a NORMAL resting state, not a fault: containers start on demand
 * (agent runs and chats lazy-start them) and the idle-stop cron parks them
 * again. It covers the never-provisioned `null` status too — the first use
 * provisions. `provisioning` covers the transient in-flight states (creating,
 * stopping). Only `running` (and not mid-rebuild) is `healthy`.
 *
 * **`error` comes from the pool, not from `container_status`.** A project is not
 * bound to one container any more: `acquireRunContainer` never reads that column
 * and the pool ladder skips failed members, so the next run just creates a fresh
 * container. `container_status = 'error'` therefore blocks nothing - and it
 * latches, because the sync loop writes it while nulling `container_id`, after
 * which no remove can name the container to clear it. Reading
 * `failed_container_count` instead means the signal is true exactly while a
 * failed container still exists, and disappears when it is removed. A project
 * whose stored status is `error` is reported as `stopped`, which is what it
 * behaves like: not running, not transient, provisioned on demand.
 */
export type ContainerHealth =
	| { kind: 'healthy' }
	| { kind: 'rebuilding'; percent: number }
	| { kind: 'provisioning'; transient: 'creating' | 'stopping' }
	| { kind: 'stopped' }
	| { kind: 'error' };

/** Returns null while the project is unknown (index still loading). */
export function useContainerHealth(project: Project | undefined): ContainerHealth | null {
	const imageBuild = useImageBuild(project?.docker_base_image);
	if (!project) return null;

	const status = project.container_status;

	// Ahead of the rebuild check: a failed container is the one state here that
	// does not resolve on its own, so it should not be masked by a build that
	// will finish by itself.
	if (project.failed_container_count > 0) return { kind: 'error' };

	// A base-image rebuild gates every container that needs the fresh image,
	// unless this one is asleep anyway (it picks the fresh image up on wake).
	if (imageBuild?.building && status !== ContainerStatus.Stopped && status !== null) {
		return { kind: 'rebuilding', percent: imageBuild.percent };
	}
	if (status === ContainerStatus.Stopped || status === ContainerStatus.Error || status === null) {
		return { kind: 'stopped' };
	}
	if (status === ContainerStatus.Running) return { kind: 'healthy' };

	// creating or stopping — in-flight, resolves on its own.
	return {
		kind: 'provisioning',
		transient: status === ContainerStatus.Stopping ? 'stopping' : 'creating',
	};
}
