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

/** Badge colours these surfaces draw from, named so the pinned case can share them. */
export type ContainerTone = 'live' | 'neutral' | 'warning' | 'danger' | 'info';

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

/**
 * How a container's state should read, given that it may be pinned to the
 * assistant.
 *
 * A chat-pinned container never enters `busy`: the assistant *pins* it and
 * leaves it `idle` for its whole life, deliberately, so nothing recycles it out
 * from under a conversation. Rendering the raw state therefore labels a
 * container "Idle" while the assistant is mid-turn in it. Naming the assistant
 * instead is honest about why it is held and why it is not being reclaimed.
 *
 * A pinned container that is genuinely doing something else - still being built,
 * or failed - keeps that state, because those say more than the reservation
 * does.
 */
export function containerBadge(
	state: ContainerState,
	reservedForChat: boolean,
): { tone: ContainerTone; label: MessageKey } {
	if (reservedForChat && (state === 'idle' || state === 'suspended')) {
		return { tone: 'info', label: 'containers.state.assistant' };
	}
	return { tone: CONTAINER_STATE_TONE[state], label: CONTAINER_STATE_LABEL[state] };
}

const GIB = 1024 ** 3;

/** Bytes as GB to one decimal - the unit both container surfaces report in. */
export function formatGib(bytes: number): string {
	return `${Math.round((bytes / GIB) * 10) / 10} GB`;
}
