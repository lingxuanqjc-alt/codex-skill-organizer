import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

interface BrowserSession {
  id: string;
  csrf: string;
  createdAt: number;
}

export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [name, ...rest] = part.trim().split("=");
      return [name ?? "", decodeURIComponent(rest.join("="))];
    }).filter(([name]) => Boolean(name)),
  );
}

export class SessionManager {
  readonly bootstrapToken = randomBytes(32).toString("base64url");
  readonly #sessionTtlMs: number;
  readonly #now: () => number;
  readonly #credentialCreatedAt: number;
  #sessions = new Map<string, BrowserSession>();

  constructor(sessionTtlMs = DEFAULT_SESSION_TTL_MS, now: () => number = Date.now) {
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1_000) {
      throw new Error("sessionTtlMs 必须是至少 1 秒的安全整数");
    }
    this.#sessionTtlMs = sessionTtlMs;
    this.#now = now;
    this.#credentialCreatedAt = this.#now();
  }

  get credentialExpiresAt(): number {
    return this.#credentialCreatedAt + this.#sessionTtlMs;
  }

  get credentialsExpired(): boolean {
    return this.#credentialExpired();
  }

  exchangeBootstrapToken(token: string): BrowserSession | null {
    if (this.#credentialExpired()) return null;
    if (!constantTimeEqual(token, this.bootstrapToken)) return null;
    const session: BrowserSession = {
      id: randomBytes(24).toString("base64url"),
      csrf: randomBytes(24).toString("base64url"),
      createdAt: this.#now(),
    };
    this.#sessions.set(session.id, session);
    this.#prune();
    return session;
  }

  authenticate(request: IncomingMessage): { mode: "bearer" | "cookie"; csrf?: string } | null {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith("Bearer ")) {
      const token = authorization.slice("Bearer ".length);
      if (!this.#credentialExpired() && constantTimeEqual(token, this.bootstrapToken)) return { mode: "bearer" };
    }
    const sessionId = parseCookies(request.headers.cookie).cso_session;
    if (!sessionId) return null;
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    if (this.#now() - session.createdAt >= this.#sessionTtlMs) {
      this.#sessions.delete(sessionId);
      return null;
    }
    return { mode: "cookie", csrf: session.csrf };
  }

  setSessionCookie(response: ServerResponse, session: BrowserSession): void {
    response.setHeader(
      "Set-Cookie",
      `cso_session=${encodeURIComponent(session.id)}; HttpOnly; SameSite=Strict; Path=/`,
    );
  }

  validateCsrf(request: IncomingMessage, auth: { mode: "bearer" | "cookie"; csrf?: string }): boolean {
    if (auth.mode === "bearer") return true;
    const supplied = request.headers["x-cso-csrf"];
    return typeof supplied === "string" && typeof auth.csrf === "string" && constantTimeEqual(supplied, auth.csrf);
  }

  #prune(): void {
    const cutoff = this.#now() - this.#sessionTtlMs;
    for (const [id, session] of this.#sessions) {
      if (session.createdAt < cutoff) this.#sessions.delete(id);
    }
  }

  #credentialExpired(): boolean {
    return this.#now() >= this.credentialExpiresAt;
  }
}
