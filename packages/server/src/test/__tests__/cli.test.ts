import { describe, it, expect } from "vitest";
import { homedir } from "os";
import { resolve } from "path";
import { parseArgs } from "../../cli";

// Helper to build argv with the standard bun/node + script prefix
const argv = (...flags: string[]) => ["bun", "src/index.ts", ...flags];

describe("parseArgs", () => {
  it("returns defaults when no args provided", () => {
    const config = parseArgs(argv());
    expect(config.port).toBe(3100);
    expect(config.dataDir).toBe(resolve(homedir(), ".hezo"));
    expect(config.connectUrl).toBe("http://localhost:4100");
    expect(config.masterKey).toBeUndefined();
    expect(config.connectApiKey).toBeUndefined();
    expect(config.reset).toBe(false);
    expect(config.noOpen).toBe(false);
  });

  it("parses --port", () => {
    const config = parseArgs(argv("--port", "8080"));
    expect(config.port).toBe(8080);
  });

  it("throws on non-numeric port", () => {
    expect(() => parseArgs(argv("--port", "abc"))).toThrow("Invalid port");
  });

  it("throws on port below valid range", () => {
    expect(() => parseArgs(argv("--port", "0"))).toThrow("Invalid port");
  });

  it("throws on port above valid range", () => {
    expect(() => parseArgs(argv("--port", "99999"))).toThrow("Invalid port");
  });

  it("parses --data-dir with absolute path", () => {
    const config = parseArgs(argv("--data-dir", "/custom/path"));
    expect(config.dataDir).toBe("/custom/path");
  });

  it("resolves tilde in --data-dir", () => {
    const config = parseArgs(argv("--data-dir", "~/custom"));
    expect(config.dataDir).toBe(resolve(homedir(), "custom"));
  });

  it("parses --master-key", () => {
    const config = parseArgs(argv("--master-key", "mykey"));
    expect(config.masterKey).toBe("mykey");
  });

  it("parses --connect-url", () => {
    const config = parseArgs(argv("--connect-url", "https://custom.example.com"));
    expect(config.connectUrl).toBe("https://custom.example.com");
  });

  it("parses --connect-api-key", () => {
    const config = parseArgs(argv("--connect-api-key", "hc_abc123"));
    expect(config.connectApiKey).toBe("hc_abc123");
  });

  it("parses --reset", () => {
    const config = parseArgs(argv("--reset"));
    expect(config.reset).toBe(true);
  });

  it("parses --no-open", () => {
    const config = parseArgs(argv("--no-open"));
    expect(config.noOpen).toBe(true);
  });

  it("handles multiple flags combined", () => {
    const config = parseArgs(
      argv(
        "--port", "9000",
        "--data-dir", "/tmp/hezo",
        "--master-key", "secret",
        "--connect-url", "https://connect.hezo.dev",
        "--connect-api-key", "hc_xyz",
        "--reset",
        "--no-open",
      ),
    );
    expect(config.port).toBe(9000);
    expect(config.dataDir).toBe("/tmp/hezo");
    expect(config.masterKey).toBe("secret");
    expect(config.connectUrl).toBe("https://connect.hezo.dev");
    expect(config.connectApiKey).toBe("hc_xyz");
    expect(config.reset).toBe(true);
    expect(config.noOpen).toBe(true);
  });
});
