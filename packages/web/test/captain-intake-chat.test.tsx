// The intake chat bubbles print plain text, so an agent message carrying a
// technical-details section shows its summary with the details behind the
// collapsed toggle instead of printing the marker line raw.

import { SUMMARY_DETAILS_HEADING } from '@hezo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { CaptainIntakeChat } from '../src/components/captain-intake-chat';
import { withI18n } from './helpers/i18n';
import './helpers/render';
import { seedComment, seedProject, seedTask, seedWorkspace } from './helpers/seed';

test('an agent message shows its summary and collapses its technical details', async () => {
	const ws = await seedWorkspace();
	const project = await seedProject(ws, { name: 'Intake Split' });
	const task = await seedTask(ws, project, { title: 'Intake' });
	await seedComment(
		ws,
		task,
		`Two questions before I set this up.\n\n${SUMMARY_DETAILS_HEADING}\n\nRoster draft: analyst, verifier.`,
		{ authorMemberId: ws.agents[0].id },
	);

	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const { findAllByTestId, getByTestId } = render(
		withI18n(
			<QueryClientProvider client={client}>
				<CaptainIntakeChat
					projectSlug={project.slug}
					taskIdentifier={task.identifier.toLowerCase()}
					captainTitle="CEO"
					awaitingCaptainReply={false}
				/>
			</QueryClientProvider>,
		),
	);

	const [message] = await findAllByTestId('home-captain-chat-message');
	expect(message.textContent).toContain('Two questions before I set this up.');
	expect(message.textContent).not.toContain(SUMMARY_DETAILS_HEADING);
	expect(message.textContent).not.toContain('Roster draft');
	fireEvent.click(getByTestId('technical-details-toggle'));
	expect(getByTestId('technical-details').textContent).toContain(
		'Roster draft: analyst, verifier.',
	);
});
