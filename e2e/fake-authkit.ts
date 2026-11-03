import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WorkOSAuthClient } from "../packages/server/src/app.js";

export const AUTHKIT_ORIGIN = "https://authkit.shareplan-test.localhost";

type AuthorizationOptions = Parameters<WorkOSAuthClient["userManagement"]["getAuthorizationUrlWithPKCE"]>[0] & {
  organizationId?: string;
  maxAge?: number;
};
type AuthenticationOptions = Parameters<WorkOSAuthClient["userManagement"]["authenticateWithCode"]>[0];

export interface FakeIdentity {
  user: { id: string; email: string; emailVerified: boolean };
  authenticationMethod?: string;
  organizationId?: string;
  impersonator?: { email: string; reason: string | null };
  accessToken: string;
}

/** Deliberately unsigned: this stands in for the trusted server-side code exchange. */
export function unsignedJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}

export function identity(
  overrides: Omit<Partial<FakeIdentity>, "user"> & { user?: Partial<FakeIdentity["user"]> } = {},
  claims: Record<string, unknown> = {},
): FakeIdentity {
  const user = { id: "user_e2e", email: "browser@example.test", emailVerified: true, ...overrides.user };
  const organizationId = overrides.organizationId ?? "org_e2e";
  return {
    authenticationMethod: "GoogleOAuth",
    organizationId,
    accessToken: unsignedJwt({
      sid: "session_e2e", org_id: organizationId, sub: user.id,
      auth_time: Math.floor(Date.now() / 1000), ...claims,
    }),
    ...overrides,
    user,
  };
}

interface Authorization {
  url: string;
  codeVerifier: string;
  identity: FakeIdentity;
}

export class FakeAuthKit {
  readonly authorizationCalls: AuthorizationOptions[] = [];
  readonly authorizationParams: Record<string, string>[] = [];
  readonly authenticationCalls: AuthenticationOptions[] = [];
  readonly logoutCalls: { sessionId: string; returnTo?: string }[] = [];
  /** While set, /authorize answers only once it resolves (Playwright routes skip redirect hops). */
  authorizeGate: Promise<void> | null = null;
  private nextIdentity: FakeIdentity | undefined;
  private readonly authorizations = new Map<string, Authorization>();
  private readonly codes = new Map<string, Authorization>();

  setNextIdentity(value: FakeIdentity): void {
    this.nextIdentity = structuredClone(value);
  }

  readonly client: WorkOSAuthClient = {
    userManagement: {
      getAuthorizationUrlWithPKCE: async (options: AuthorizationOptions) => {
        if (!this.nextIdentity) throw new Error("Call authkit.setNextIdentity() before each sign-in");
        const state = randomBytes(32).toString("base64url");
        const codeVerifier = randomBytes(32).toString("base64url");
        const url = new URL("/authorize", AUTHKIT_ORIGIN);
        url.search = new URLSearchParams({
          client_id: options.clientId,
          provider: options.provider,
          redirect_uri: options.redirectUri,
          response_type: "code",
          state,
          code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
          code_challenge_method: "S256",
          ...(options.screenHint ? { screen_hint: options.screenHint } : {}),
          ...(options.organizationId !== undefined ? { organization_id: options.organizationId } : {}),
          ...(options.maxAge !== undefined ? { max_age: String(options.maxAge) } : {}),
        }).toString();
        this.authorizationCalls.push(structuredClone(options));
        this.authorizationParams.push(Object.fromEntries(url.searchParams));
        this.authorizations.set(state, { url: url.href, codeVerifier, identity: this.nextIdentity });
        this.nextIdentity = undefined;
        return { url: url.href, state, codeVerifier };
      },
      authenticateWithCode: async (options: AuthenticationOptions) => {
        this.authenticationCalls.push(structuredClone(options));
        const authorization = this.codes.get(options.code);
        this.codes.delete(options.code);
        if (!authorization || authorization.codeVerifier !== options.codeVerifier) {
          throw new Error("Invalid, reused, or PKCE-mismatched fake AuthKit code");
        }
        return structuredClone(authorization.identity);
      },
      getLogoutUrl: (options) => {
        this.logoutCalls.push(structuredClone(options));
        const url = new URL("/logout", AUTHKIT_ORIGIN);
        url.searchParams.set("session_id", options.sessionId);
        if (options.returnTo !== undefined) url.searchParams.set("return_to", options.returnTo);
        return url.href;
      },
    },
    organizations: {
      getOrganization: async (id) => ({ id, name: `Fake ${id}` }),
    },
  };

  handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url!, AUTHKIT_ORIGIN);
    if (req.method === "GET" && url.pathname === "/logout") {
      // Ends the fake AuthKit session and returns to the registered apex root.
      const returnTo = url.searchParams.get("return_to");
      if (!this.logoutCalls.some(call => call.sessionId === url.searchParams.get("session_id")) ||
          !returnTo || new URL(returnTo).pathname !== "/") {
        res.writeHead(400).end("Unknown fake AuthKit logout request");
        return;
      }
      res.writeHead(302, { location: returnTo, "cache-control": "no-store" }).end();
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    const authorization = this.authorizations.get(state);
    if (req.method !== "GET" || !authorization || url.href !== authorization.url) {
      res.writeHead(400).end("Unknown fake AuthKit authorization request");
      return;
    }
    this.authorizations.delete(state);
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, authorization);
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    const respond = () => res.writeHead(302, { location: callback.href, "cache-control": "no-store" }).end();
    if (this.authorizeGate) void this.authorizeGate.then(respond);
    else respond();
  }
}
