import type { MessageKey } from './i18n';

/**
 * The states a container can be in, as the pool records them.
 *
 * Declared here rather than in the hook so the two tables below can be
 * `Record`s over it: an added state then fails to compile until it has both a
 * colour and a label, instead of rendering grey and unnamed - which is the one
 * mistake that would make an operator leave a broken container alone.
 */
export type ContainerState = 'creating' | 'idle' | 'busy' | 'suspended' | 'error';

/** Badge colours these surfaces draw from. */
export type ContainerTone = 'live' | 'neutral' | 'warning' | 'danger';

export const CONTAINER_STATE_TONE: Record<ContainerState, ContainerTone> = {
	creating: 'warning',
	idle: 'neutral',
	busy: 'live',
	suspended: 'neutral',
	error: 'danger',
};

/**
 * A table rather than an interpolated `t(\`containers.state.${state}\`)`: the
 * catalog check reads key *literals* out of the source, so an interpolated key
 * reads as authored-but-unused and the state names look like dead translations.
 */
export const CONTAINER_STATE_LABEL: Record<ContainerState, MessageKey> = {
	creating: 'containers.state.creating',
	idle: 'containers.state.idle',
	busy: 'containers.state.busy',
	suspended: 'containers.state.suspended',
	error: 'containers.state.error',
};

/** A container's state badge. Chat turns claim members busy like any run, so the raw state is the whole story. */
export function containerBadge(state: ContainerState): { tone: ContainerTone; label: MessageKey } {
	return { tone: CONTAINER_STATE_TONE[state], label: CONTAINER_STATE_LABEL[state] };
}

/**
 * Re-exported rather than defined here: the runner writes the same figures into
 * the run log, so the rounding has to be one function for both packages.
 */
export { formatGib } from '@hezo/shared';
