import { createContext, useContext } from 'react';

/**
 * Whether the chat dock is open. The fresh-instance landing renders the same
 * CEO surface full-pane, and two live mounts of one room would double-mark
 * reads and double-render every message - so the landing yields to the dock
 * while it is open.
 */
export const ChatDockOpenContext = createContext(false);

export function useChatDockOpen(): boolean {
	return useContext(ChatDockOpenContext);
}
