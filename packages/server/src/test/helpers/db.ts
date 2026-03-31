import { PGlite } from "@electric-sql/pglite";
import { BASE_SCHEMA } from "../../db/schema";

/** Creates a fresh in-memory PGlite instance with base tables for testing. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  return db;
}

/** Creates a test DB with full migrations applied (falls back to base schema). */
export async function createTestDbWithMigrations(): Promise<PGlite> {
  const db = new PGlite();
  try {
    const { runMigrations, loadFilesystemMigrations } = await import(
      "../../db/migrate.js"
    );
    const { join } = await import("path");
    const migrationsDir = join(
      new URL(".", import.meta.url).pathname,
      "..",
      "..",
      "..",
      "migrations",
    );
    const migrations = await loadFilesystemMigrations(migrationsDir);
    await runMigrations(db, migrations);
  } catch {
    await db.exec(BASE_SCHEMA);
  }
  return db;
}
