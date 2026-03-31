import { Hono } from "hono";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { healthRoutes } from "./routes/health";
import { BASE_SCHEMA } from "./db/schema";

export type MasterKeyState = "unset" | "locked" | "unlocked";

export interface HezoConfig {
  port: number;
  dataDir: string;
  masterKey?: string;
  connectUrl: string;
  connectApiKey?: string;
  reset: boolean;
}

export interface StartupResult {
  app: Hono;
  port: number;
  masterKeyState: MasterKeyState;
}

export async function startup(config: HezoConfig): Promise<StartupResult> {
  const pgDataPath = join(config.dataDir, "pgdata");

  if (config.reset) {
    rmSync(pgDataPath, { recursive: true, force: true });
  }

  mkdirSync(config.dataDir, { recursive: true });

  const { PGlite } = await import("@electric-sql/pglite");
  let db: InstanceType<typeof PGlite>;

  try {
    const { NodeFS } = await import("@electric-sql/pglite/nodefs");
    db = new PGlite({ fs: new NodeFS(pgDataPath) });
  } catch {
    db = new PGlite();
  }

  await db.exec(BASE_SCHEMA);
  await runAvailableMigrations(db);

  const masterKeyState = await resolveMasterKeyState(db, config.masterKey);
  const app = buildApp(masterKeyState);

  return { app, port: config.port, masterKeyState };
}

async function runAvailableMigrations(db: any): Promise<void> {
  try {
    const { runMigrations, loadBundledMigrations } = await import(
      "./db/migrate.js"
    );
    const migrations = await loadBundledMigrations();
    await runMigrations(db, migrations);
  } catch {
    try {
      const { runMigrations, loadFilesystemMigrations } = await import(
        "./db/migrate.js"
      );
      const migrationsDir = join(
        new URL(".", import.meta.url).pathname,
        "..",
        "migrations",
      );
      const migrations = await loadFilesystemMigrations(migrationsDir);
      await runMigrations(db, migrations);
    } catch {
      console.warn(
        "No migrations found. Run build:migrations or add migration files.",
      );
    }
  }
}

async function resolveMasterKeyState(
  db: any,
  masterKey?: string,
): Promise<MasterKeyState> {
  try {
    const { MasterKeyManager } = await import("./crypto/master-key.js");
    const manager = new MasterKeyManager();
    const state = await manager.initialize(db, masterKey);

    const messages: Record<string, string> = {
      unlocked: "Master key verified. Server unlocked.",
      unset: "No master key set. Set via web UI on first login.",
      locked: masterKey
        ? "Invalid master key provided. Server starting in locked state."
        : "Server starting in locked state. Provide master key to unlock.",
    };
    console.log(messages[state]);
    return state;
  } catch {
    console.warn("Master key module not available. Skipping key verification.");
    return "unset";
  }
}

function buildApp(masterKeyState: MasterKeyState): Hono {
  const app = new Hono();

  app.route("/", healthRoutes);

  app.get("/api/status", (c) =>
    c.json({
      masterKeyState,
      version: "0.1.0",
    }),
  );

  return app;
}
