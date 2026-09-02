import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// **Nothing from the app.** These specs render the primitives alone — no
// server, no router, no catalog — which is the property the package exists to
// have, so the setup that supports them stays that thin on purpose.
afterEach(cleanup);
