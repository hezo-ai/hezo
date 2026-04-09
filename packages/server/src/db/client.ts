import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

export async function createDb(dataDir: string): Promise<PGlite> {
	const { NodeFS } = await import('@electric-sql/pglite/nodefs');
	const { join } = await import('node:path');
	const pgDataPath = join(dataDir, 'pgdata');
	return new PGlite({ fs: new NodeFS(pgDataPath), extensions: { vector } });
}

export async function createMemoryDb(): Promise<PGlite> {
	return new PGlite({ extensions: { vector } });
}
