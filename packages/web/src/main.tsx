import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from './components/ui/toast';
import { ThemeProvider } from './lib/theme';
import { routeTree } from './routeTree.gen';
import './index.css';

const router = createRouter({ routeTree });

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
