import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ActorBadge } from '../src/components/ui/actor-badge';
import { withI18n } from './helpers/i18n';

test('renders a bot badge for an API key', () => {
	const { getByTestId, queryByTestId } = render(
		withI18n(<ActorBadge actorType="api_key" name="CRM Bot" />),
	);
	expect(getByTestId('actor-badge-api-key').getAttribute('aria-label')).toBe('API key');
	expect(queryByTestId('actor-badge-human')).toBeNull();
});

test('renders a human badge for admin and user actor types', () => {
	for (const actorType of ['admin', 'user']) {
		const { getByTestId, unmount } = render(
			withI18n(<ActorBadge actorType={actorType} name="Alice" />),
		);
		expect(getByTestId('actor-badge-human').getAttribute('aria-label')).toBe('Human admin');
		unmount();
	}
});

test('renders nothing for roster agents and system actors', () => {
	for (const actorType of ['agent', 'system', null, undefined]) {
		const { container, unmount } = render(withI18n(<ActorBadge actorType={actorType} />));
		expect(container.querySelector('[data-testid^="actor-badge"]')).toBeNull();
		unmount();
	}
});
