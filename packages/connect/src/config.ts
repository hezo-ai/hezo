import { randomBytes } from "crypto";

export interface ConnectConfig {
  port: number;
  mode: "self_hosted";
  stateSigningKey: string;
  github?: {
    clientId: string;
    clientSecret: string;
  };
}

export function loadConfig(): ConnectConfig {
  const port = parseInt(process.env.HEZO_CONNECT_PORT || "4100", 10);

  let stateSigningKey = process.env.STATE_SIGNING_KEY || "";
  if (!stateSigningKey) {
    stateSigningKey = randomBytes(32).toString("hex");
    console.log(
      "Auto-generated state signing key (set STATE_SIGNING_KEY env var to persist)"
    );
  }

  const githubClientId = process.env.GITHUB_CLIENT_ID;
  const githubClientSecret = process.env.GITHUB_CLIENT_SECRET;

  return {
    port,
    mode: "self_hosted",
    stateSigningKey,
    github:
      githubClientId && githubClientSecret
        ? { clientId: githubClientId, clientSecret: githubClientSecret }
        : undefined,
  };
}
