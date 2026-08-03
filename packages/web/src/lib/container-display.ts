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

export const CONTAINER_STATE_TONE: Record<
	ContainerState,
	'live' | 'neutral' | 'warning' | 'danger'
> = {
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

const GIB = 1024 ** 3;

/** Bytes as GB to one decimal - the unit both container surfaces report in. */
export function formatGib(bytes: number): string {
	return `${Math.round((bytes / GIB) * 10) / 10} GB`;
}
