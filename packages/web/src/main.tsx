import { createRouter, Navigate, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from './components/ui/toast';
import { ThemeProvider } from './lib/theme';
import { routeTree } from './routeTree.gen';
import './index.css';

// Unknown URLs — including legacy team-scoped paths (`/teams/...`) from before
// the project-centric routing change — fall back to Home rather than a dead end.
const router = createRouter({
	routeTree,
	defaultNotFoundComponent: () => <Navigate to="/home" replace />,
});

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
	interface StaticDataRouteOption {
		// Routes that render full-viewport without the global app shell.
		bare?: boolean;
	}
}

createRoot(document.getElementById('root') as HTMLElement).render(
	<StrictMode>
		<ThemeProvider>
			<RouterProvider router={router} />
			<Toaster />
		</ThemeProvider>
	</StrictMode>,
);
