import { ContainerStatus } from '@hezo/shared';
import { useImageBuild } from './use-image-build';
import type { Project } from './use-projects';

/**
 * Normalised health of a project's container, derived from its stored status
 * plus any in-flight base-image build. A single source of truth shared by the
 * container status banner, the CEO chat, and the create-project gate so they
 * never disagree about whether a container is usable.
 *
 * `provisioning` covers the transient setup/teardown states (creating, stopping)
 * and the not-yet-provisioned `null` status — anything that should resolve to
 * running on its own. Only `running` (and not mid-rebuild) is `healthy`.
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
	// unless the operator deliberately stopped this one.
	if (imageBuild?.building && status !== ContainerStatus.Stopped) {
		return { kind: 'rebuilding', percent: imageBuild.percent };
	}
	if (status === ContainerStatus.Error) return { kind: 'error' };
	if (status === ContainerStatus.Stopped) return { kind: 'stopped' };
	if (status === ContainerStatus.Running) return { kind: 'healthy' };

	// creating, stopping, or null (never provisioned / warming up at boot).
	return {
		kind: 'provisioning',
		transient: status === ContainerStatus.Stopping ? 'stopping' : 'creating',
	};
}
