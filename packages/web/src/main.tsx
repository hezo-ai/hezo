import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { routeTree } from './routeTree.gen';
import './index.css';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}

createRoot(document.getElementById('root') as HTMLElement).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>,
);
