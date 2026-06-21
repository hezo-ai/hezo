import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ActorBadge } from '../src/components/ui/actor-badge';

test('renders a bot badge for a connected agent', () => {
	const { getByTestId, queryByTestId } = render(
		<ActorBadge actorType="connected_agent" name="CRM Bot" />,
	);
	expect(getByTestId('actor-badge-connected-agent').getAttribute('aria-label')).toBe(
		'Connected agent',
	);
	expect(queryByTestId('actor-badge-human')).toBeNull();
});

test('renders a human badge for admin and user actor types', () => {
	for (const actorType of ['admin', 'user']) {
		const { getByTestId, unmount } = render(<ActorBadge actorType={actorType} name="Alice" />);
		expect(getByTestId('actor-badge-human').getAttribute('aria-label')).toBe('Human admin');
		unmount();
	}
});

test('renders nothing for roster agents and system actors', () => {
	for (const actorType of ['agent', 'system', null, undefined]) {
		const { container, unmount } = render(<ActorBadge actorType={actorType} />);
		expect(container.querySelector('[data-testid^="actor-badge"]')).toBeNull();
		unmount();
	}
});
