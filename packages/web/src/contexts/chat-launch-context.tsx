import { createContext, useContext } from 'react';

/**
 * A request to open the CEO chat on a specific thread with the composer already
 * filled in. `nonce` is what makes an identical request re-apply: the widget
 * keys its effect on it, so launching the same thread with the same draft twice
 * still refills a composer the operator has since cleared.
 */
export interface ChatLaunch {
	/** Thread to show. */
	conversationId: string;
	/** Text to put in the composer. Deliberately NOT sent - see `useLaunchChat`. */
	draft: string;
	nonce: number;
}

/**
 * Lets any surface open the CEO chat on a thread it just created, with a draft
 * message waiting to be sent. The chat's open state and thread selection live in
 * the app shell and the widget respectively, so without this a route could not
 * reach either.
 *
 * The draft is **prefilled, never auto-sent**. A generic opening line ("I want to
 * add an agent to X") gives the CEO nothing to act on, so its first reply is
 * forced to be a question; leaving the cursor in the box lets the operator answer
 * that question before it is asked. Sending it for them cannot be taken back,
 * while a prefill they have nothing to add to is one keypress from being sent.
 *
 * The value is the launch callback, matching `ScrollContentContext`'s shape.
 */
export const ChatLaunchContext = createContext<(launch: Omit<ChatLaunch, 'nonce'>) => void>(
	() => {},
);

/** Open the CEO chat on a thread, with `draft` waiting in the composer. */
export function useLaunchChat(): (launch: Omit<ChatLaunch, 'nonce'>) => void {
	return useContext(ChatLaunchContext);
}
