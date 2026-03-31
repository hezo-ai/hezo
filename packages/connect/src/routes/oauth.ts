import { Hono } from "hono";
import type { ConnectConfig } from "../config.js";
import {
  signState,
  verifyState,
  createNonce,
  NonceStore,
  type StatePayload,
} from "../crypto/state.js";
import {
  exchangeCode,
  fetchUserInfo,
  type FetchFn,
} from "../providers/github.js";

const SUPPORTED_PLATFORMS = new Set(["github"]);
const GITHUB_SCOPES = "repo,workflow,read:org";

function errorRedirect(
  callbackUrl: string,
  platform: string,
  errorCode: string,
  message?: string
): string {
  const url = new URL(callbackUrl);
  url.searchParams.set("error", errorCode);
  url.searchParams.set("platform", platform);
  if (message) url.searchParams.set("message", message);
  return url.toString();
}

export function oauthRoutes(
  config: ConnectConfig,
  nonceStore: NonceStore,
  fetchFn: FetchFn = globalThis.fetch
): Hono {
  const routes = new Hono();

  routes.get("/auth/:platform/start", (c) => {
    const platform = c.req.param("platform");

    if (!SUPPORTED_PLATFORMS.has(platform)) {
      return c.json(
        { error: "unsupported_platform", message: `Platform "${platform}" is not supported` },
        400
      );
    }

    const callbackUrl = c.req.query("callback");
    if (!callbackUrl) {
      return c.json(
        { error: "missing_callback", message: "callback query parameter is required" },
        400
      );
    }

    if (!config.github) {
      return c.redirect(
        errorRedirect(callbackUrl, platform, "missing_config", "GitHub OAuth is not configured")
      );
    }

    const nonce = createNonce();
    nonceStore.add(nonce);

    const payload: StatePayload = {
      callback_url: callbackUrl,
      platform,
      nonce,
      timestamp: new Date().toISOString(),
    };

    const originalState = c.req.query("state");
    if (originalState) payload.original_state = originalState;

    const signedState = signState(payload, config.stateSigningKey);

    const connectCallbackUrl = new URL(c.req.url);
    connectCallbackUrl.pathname = `/auth/${platform}/callback`;
    connectCallbackUrl.search = "";

    const githubUrl = new URL("https://github.com/login/oauth/authorize");
    githubUrl.searchParams.set("client_id", config.github.clientId);
    githubUrl.searchParams.set("redirect_uri", connectCallbackUrl.toString());
    githubUrl.searchParams.set("scope", GITHUB_SCOPES);
    githubUrl.searchParams.set("state", signedState);

    return c.redirect(githubUrl.toString());
  });

  routes.get("/auth/:platform/callback", async (c) => {
    const platform = c.req.param("platform");
    const code = c.req.query("code");
    const stateParam = c.req.query("state");

    if (!SUPPORTED_PLATFORMS.has(platform)) {
      return c.json(
        { error: "unsupported_platform", message: `Platform "${platform}" is not supported` },
        400
      );
    }

    if (!stateParam) {
      return c.json({ error: "invalid_state", message: "Missing state parameter" }, 400);
    }

    const payload = verifyState(stateParam, config.stateSigningKey);
    if (!payload) {
      return c.json({ error: "invalid_state", message: "Invalid state signature" }, 400);
    }

    const callbackUrl = payload.callback_url;

    if (!nonceStore.consume(payload.nonce)) {
      return c.redirect(
        errorRedirect(callbackUrl, platform, "expired_nonce", "Nonce expired or already used")
      );
    }

    if (c.req.query("error") === "access_denied") {
      return c.redirect(
        errorRedirect(callbackUrl, platform, "access_denied", "User denied authorization")
      );
    }

    if (!code) {
      return c.redirect(
        errorRedirect(callbackUrl, platform, "invalid_state", "Missing authorization code")
      );
    }

    if (!config.github) {
      return c.redirect(
        errorRedirect(callbackUrl, platform, "missing_config", "GitHub OAuth is not configured")
      );
    }

    const connectCallbackUrl = new URL(c.req.url);
    connectCallbackUrl.search = "";

    try {
      const tokenResponse = await exchangeCode(
        code,
        config.github.clientId,
        config.github.clientSecret,
        connectCallbackUrl.toString(),
        fetchFn
      );

      const userInfo = await fetchUserInfo(tokenResponse.access_token, fetchFn);

      const metadata = Buffer.from(
        JSON.stringify({
          username: userInfo.login,
          avatar_url: userInfo.avatar_url,
          email: userInfo.email,
        })
      ).toString("base64url");

      const redirectUrl = new URL(callbackUrl);
      redirectUrl.searchParams.set("platform", platform);
      redirectUrl.searchParams.set("access_token", tokenResponse.access_token);
      redirectUrl.searchParams.set("scopes", tokenResponse.scope);
      redirectUrl.searchParams.set("metadata", metadata);
      if (payload.original_state) {
        redirectUrl.searchParams.set("state", payload.original_state);
      }

      return c.redirect(redirectUrl.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Token exchange failed";
      return c.redirect(
        errorRedirect(callbackUrl, platform, "token_exchange_failed", message)
      );
    }
  });

  return routes;
}
