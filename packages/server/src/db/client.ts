import { PGlite } from "@electric-sql/pglite";

export async function createDb(dataDir: string): Promise<PGlite> {
  const { NodeFS } = await import("@electric-sql/pglite/nodefs");
  const { join } = await import("path");
  const pgDataPath = join(dataDir, "pgdata");
  return new PGlite({ fs: new NodeFS(pgDataPath) });
}

export async function createMemoryDb(): Promise<PGlite> {
  return new PGlite();
}
