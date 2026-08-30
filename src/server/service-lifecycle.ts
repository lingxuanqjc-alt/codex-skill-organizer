export interface ServiceLifecycleOptions {
  idleTimeoutMs: number;
  desktopLeaseTtlMs: number;
  now?: () => number;
}

export interface DesktopLeaseUpdateResult {
  accepted: boolean;
  active: boolean;
  generation: number;
  expiresAt: number | null;
}

interface DesktopLeaseState {
  active: boolean;
  generation: number;
  expiresAt: number;
}

const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Owns the shared server's idle decision. Desktop windows hold expiring leases;
 * every accepted loopback request independently refreshes the idle deadline.
 */
export class ServiceLifecycle {
  readonly #idleTimeoutMs: number;
  readonly #desktopLeaseTtlMs: number;
  readonly #now: () => number;
  readonly #desktopLeases = new Map<string, DesktopLeaseState>();
  #lastRequestActivityAt: number;

  constructor(options: ServiceLifecycleOptions) {
    if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 1_000) {
      throw new Error("idleTimeoutMs 必须是至少 1 秒的安全整数");
    }
    if (!Number.isSafeInteger(options.desktopLeaseTtlMs) || options.desktopLeaseTtlMs < 1_000) {
      throw new Error("desktopLeaseTtlMs 必须是至少 1 秒的安全整数");
    }
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#desktopLeaseTtlMs = options.desktopLeaseTtlMs;
    this.#now = options.now ?? Date.now;
    this.#lastRequestActivityAt = this.#now();
  }

  recordRequest(): void {
    this.#lastRequestActivityAt = this.#now();
  }

  updateDesktopLease(leaseId: string, active: boolean, generation: number): DesktopLeaseUpdateResult {
    if (!LEASE_ID_PATTERN.test(leaseId)) throw new Error("桌面租约 ID 无效");
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("桌面租约 generation 无效");
    const previous = this.#desktopLeases.get(leaseId);
    if (previous && generation <= previous.generation) {
      return {
        accepted: false,
        active: previous.active && previous.expiresAt > this.#now(),
        generation: previous.generation,
        expiresAt: previous.active ? previous.expiresAt : null,
      };
    }

    const expiresAt = active ? this.#now() + this.#desktopLeaseTtlMs : this.#now();
    this.#desktopLeases.set(leaseId, { active, generation, expiresAt });
    return { accepted: true, active, generation, expiresAt: active ? expiresAt : null };
  }

  shouldShutdown(): boolean {
    const now = this.#now();
    for (const lease of this.#desktopLeases.values()) {
      if (lease.active && lease.expiresAt > now) return false;
    }
    return now - this.#lastRequestActivityAt >= this.#idleTimeoutMs;
  }
}
