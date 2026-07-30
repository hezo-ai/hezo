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
 * stopping). Only `running` (and not mid-rebuild) is `healthy`; only `error`
 * deserves error styling.
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

	// A base-image rebuild gates every container that needs the fresh image,
	// unless this one is asleep anyway (it picks the fresh image up on wake).
	if (imageBuild?.building && status !== ContainerStatus.Stopped && status !== null) {
		return { kind: 'rebuilding', percent: imageBuild.percent };
	}
	if (status === ContainerStatus.Error) return { kind: 'error' };
	if (status === ContainerStatus.Stopped || status === null) return { kind: 'stopped' };
	if (status === ContainerStatus.Running) return { kind: 'healthy' };

	// creating or stopping — in-flight, resolves on its own.
	return {
		kind: 'provisioning',
		transient: status === ContainerStatus.Stopping ? 'stopping' : 'creating',
	};
}
