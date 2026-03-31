import { describe, it, expect } from "vitest";
import { createApp } from "../../app.js";
import type { ConnectConfig } from "../../config.js";

const config: ConnectConfig = {
  port: 4100,
  mode: "self_hosted",
  stateSigningKey: "test-key",
  github: { clientId: "test-id", clientSecret: "test-secret" },
};

const app = createApp(config);

describe("GET /health", () => {
  it("returns 200 with { ok: true }", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("GET /platforms", () => {
  it("returns platform list with github", async () => {
    const res = await app.request("/platforms");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.platforms).toHaveLength(1);
    expect(body.platforms[0]).toEqual({
      id: "github",
      name: "GitHub",
      scopes: ["repo", "workflow", "read:org"],
    });
  });
});

describe("GET /signing-key", () => {
  it("returns the hex signing key", async () => {
    const res = await app.request("/signing-key");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key).toBe("test-key");
  });
});
