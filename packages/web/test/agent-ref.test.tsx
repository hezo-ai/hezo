import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { AgentRef } from '../src/components/agent-ref';
import { withI18n } from './helpers/i18n';

// `AgentRef` is the one place an agent is named in the UI, so what is pinned here
// is the naming rule itself: the label, and whether there is anything left to say
// on hover. The card's *content* renders into a Radix portal that only mounts
// once open, which needs a real layout engine - the visible hover behaviour lives
// in the Playwright tier. What happy-dom can see is the trigger: Radix stamps
// `data-state` on it, so its presence is a faithful proxy for "this label has a
// card" without asserting on the floating panel.
//
// The `link` variants are exercised through the surfaces that use them
// (comment authors, assignee, agent queue), which have a router in the tree.

const TRIGGER = '[data-state]';

test('a named agent shows its name, not its role', () => {
	const { container } = render(
		withI18n(<AgentRef agent={{ human_name: 'Riley', title: 'Market Researcher' }} />),
	);
	expect(container.textContent).toBe('Riley');
});

test('an unnamed agent shows its role', () => {
	const { container } = render(withI18n(<AgentRef agent={{ title: 'Market Researcher' }} />));
	expect(container.textContent).toBe('Market Researcher');
});

test('a blank human_name falls back to the role rather than rendering empty', () => {
	const { container } = render(
		withI18n(<AgentRef agent={{ human_name: '   ', title: 'Market Researcher' }} />),
	);
	expect(container.textContent).toBe('Market Researcher');
});

test('a named agent carries a card, since the label alone never says the role', () => {
	const { container } = render(
		withI18n(<AgentRef agent={{ human_name: 'Riley', title: 'Market Researcher' }} />),
	);
	expect(container.querySelector(TRIGGER)).not.toBeNull();
});

test('an unnamed agent with no role description carries no card', () => {
	// The label already is the role, and a description is the only thing left to
	// add — so a card here would repeat the label back at the reader.
	const { container } = render(withI18n(<AgentRef agent={{ title: 'Market Researcher' }} />));
	expect(container.querySelector(TRIGGER)).toBeNull();
});

test('an unnamed agent with a role description does carry a card', () => {
	const { container } = render(
		withI18n(
			<AgentRef
				agent={{ title: 'Market Researcher', role_description: 'Screens and sources ideas.' }}
			/>,
		),
	);
	expect(container.querySelector(TRIGGER)).not.toBeNull();
});

test('the label is its own accessible name, with no aria-label overriding it', () => {
	// A bare span has no role that supports `aria-label`, and the visible text
	// already says the name - so there is nothing to override it with.
	const { container } = render(
		withI18n(<AgentRef agent={{ human_name: 'Riley', title: 'Market Researcher' }} />),
	);
	const trigger = container.querySelector(TRIGGER);
	expect(trigger?.textContent).toBe('Riley');
	expect(trigger?.getAttribute('aria-label')).toBeNull();
});

test('tapToOpen=false still renders the card trigger, minus the tap handler', () => {
	// Set by `AgentStatusLabel`, whose callers all render it inside a link row or a
	// menu button: opening the card swallows the tap that would have navigated.
	const { container } = render(
		withI18n(
			<AgentRef agent={{ human_name: 'Riley', title: 'Market Researcher' }} tapToOpen={false} />,
		),
	);
	expect(container.querySelector(TRIGGER)).not.toBeNull();
});

test('falls back to a supplied name when the agent could not be resolved', () => {
	// A projection that baked a label before the agent left the roster still reads
	// as something rather than vanishing.
	const { container } = render(withI18n(<AgentRef fallbackName="Former Teammate" />));
	expect(container.textContent).toBe('Former Teammate');
	expect(container.querySelector(TRIGGER)).toBeNull();
});

test('renders nothing when there is neither an agent nor a fallback', () => {
	const { container } = render(withI18n(<AgentRef />));
	expect(container.textContent).toBe('');
});
