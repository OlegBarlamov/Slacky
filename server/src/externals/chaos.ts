// Simulates the network between us and an external system: latency, random failures, outages.
// Tuned live from the dev panel.

export interface Chaos {
  latencyMs: number;
  failureRate: number; // 0..1
  offline: boolean;
}

export type ChaosSettings = Record<string, Chaos>;

const NONE: Chaos = { latencyMs: 0, failureRate: 0, offline: false };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Network {
  constructor(readonly settings: ChaosSettings = {}) {}

  get(name: string): Chaos {
    return this.settings[name] ?? NONE;
  }

  set(name: string, patch: Partial<Chaos>) {
    this.settings[name] = { ...this.get(name), ...patch };
  }

  /** Calls `fn` as if it were a remote call to `name`. */
  async call<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const c = this.get(name);
    if (c.latencyMs) await sleep(c.latencyMs * (0.5 + Math.random()));
    if (c.offline) throw new Error(`${name} is unavailable`);
    if (Math.random() < c.failureRate) throw new Error(`${name} request failed`);
    return fn();
  }
}
