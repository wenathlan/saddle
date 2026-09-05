/**
 * index.ts — the stable public API of the saddle grand merge (v2.0.0).
 *
 * Section 1 carries the e2ugh virtual-hardware engine core (the library-first
 * entry point of the merged e2ugh repository: the main factory
 * createVirtualEngine, the dependency-free specification validator
 * validateSpec, the random endpoint allocator randomPort, the Map-based
 * internal memory store InternalMemory, the disposable metrics store
 * MetricsStore, the strongly typed event bus enginebus, and the plan planner
 * absorbed from the former architect.ts).
 *
 * Section 2 routes the saddle domain surface through the root-level domain
 * files of the consolidation: one optimized TypeScript file per correlated
 * domain, every former nested folder of both repositories folded at the
 * repository root.
 */

/* ── Section 1: the e2ugh virtual-hardware engine core ── */

import { randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { migprofileid } from './virtualmemory.js';

/* ------------------------------------------------------------------ */
/* Section 1: reference versions                                       */
/* ------------------------------------------------------------------ */

/**
 * Frozen table of the reference toolchain versions that the engine targets.
 * Every value was confirmed against primary sources on 2026-08-22 and is
 * embedded here so generated documentation and workflows can cite exact
 * versions without a network round trip. the v2 merge adds the microvm
 * runtime anchors so every module (orchestrator, virtualization, security)
 * cites the same ledger.
 */
export const engineversions = {
  /** npm latest confirmed 2026-08-23 (v12 shipped july 2026). */
  npm: '12.0.2',
  /** python stable confirmed 2026-08-23. */
  python: '3.14.7',
  nodecurrent: '26.7.0',
  nodelts: '24.19.0',
  typescript: '7.0.2',
  docker: '29.7.2',
  compose: '5.5.0',
  mesaa: '26.2.1',
  qemu: '11.1.0',
  firecracker: '1.16.1',
  kata: '4.1.0',
  gvisor: 'release-20260817.0',
  cloudhypervisor: '53.0',
  criu: '4.2.1',
  /* v3-VERIFY corrections (worklog 2026-08-23): kernel "7.2.1" never
   * existed (mainline 7.2, stable 7.1.9, longterm 6.18.45) and wgpu
   * moved from 24.x to 30.x; wasmtime 48.0.0 LTS confirmed. */
  kernelmainline: '7.2',
  kernelstable: '7.1.9',
  kernellongterm: '6.18.45',
  wasmtime: '48.0.0',
  wgpu: '30.x',
} as const satisfies Record<string, string>;

/** Union of every key available in the engineversions table. */
export type engineversionkey = keyof typeof engineversions;

/* ------------------------------------------------------------------ */
/* Section 2: engine limits and specification types                    */
/* ------------------------------------------------------------------ */

/** Numeric bounds applied to every engine specification. */
export type enginelimits = {
  readonly minvcpu: number;
  readonly maxvcpu: number;
  readonly minramgb: number;
  readonly maxramgb: number;
  readonly minvramgb: number;
  readonly maxvramgb: number;
  readonly minport: number;
  readonly maxport: number;
};

/**
 * Hard limits of the virtual hardware generation. Values mirror the extremes
 * of the embedded processor bank: 1 to 192 vCPUs (EPYC 9965 class), 1 to
 * 1024 GB of guest RAM, 8 to 96 GB of virtualized VRAM (RTX PRO 6000 class with
 * MIG slicing) and the random port range 30000-59999.
 */
export const enginelimits = {
  minvcpu: 1,
  maxvcpu: 192,
  minramgb: 1,
  maxramgb: 1024,
  minvramgb: 8,
  maxvramgb: 96,
  minport: 30000,
  maxport: 59999,
} as const satisfies enginelimits;

/** Runtime backend that executes the virtual machine workload. */
export type engineruntime = 'qemu' | 'firecracker' | 'docker' | 'gvisor';

/** Lifecycle states of a virtual engine instance. */
export type enginestate = 'created' | 'starting' | 'running' | 'degraded' | 'stopped';

/** Full declarative specification of one virtual hardware machine. */
export type enginespec = {
  readonly model: string;
  readonly vcpus: number;
  readonly ramgb: number;
  readonly vramgb: number;
  readonly mig: migprofileid;
  readonly runtime: engineruntime;
  readonly host: string;
  readonly port: number;
  readonly metricsintervalms: number;
};

/** Resolved network endpoint of a running engine. */
export type engineendpoint = {
  readonly host: string;
  readonly port: number;
  readonly url: string;
};

/** Options accepted by createVirtualEngine; every field is optional. */
export type engineoptions = {
  readonly model?: string;
  readonly vcpus?: number;
  readonly ramgb?: number;
  readonly vramgb?: number;
  readonly mig?: migprofileid;
  readonly runtime?: engineruntime;
  readonly host?: string;
  readonly port?: number;
  readonly metricsintervalms?: number;
};

/* ------------------------------------------------------------------ */
/* Section 3: random port allocation and host resolution               */
/* ------------------------------------------------------------------ */

/**
 * Returns a random TCP port in the 30000-59999 range using a
 * cryptographically secure generator (node:crypto randomInt). The user may
 * override the random draw by passing an explicit port, which is validated
 * against the engine limits before being returned.
 *
 * @param override Explicit port chosen by the user; when omitted a random
 *   port is drawn, which keeps the library free of fixed addresses.
 */
export function randomPort(override?: number): number {
  try {
    if (typeof override === 'number') {
      if (
        !Number.isInteger(override) ||
        override < enginelimits.minport ||
        override > enginelimits.maxport
      ) {
        throw new RangeError(
          `port must be an integer between ${enginelimits.minport} and ${enginelimits.maxport}`,
        );
      }
      return override;
    }
    return 30000 + randomInt(30000);
  } catch (cause) {
    throw new engineerror('randomPort failed', { cause: cause as Error });
  }
}

/**
 * Resolves the bind host from explicit preference or the environment
 * variables `virtualenginehost` or `vhehost`. No default address such as
 * localhost is ever assumed implicitly: when neither argument nor
 * environment provides a host the function fails loudly, keeping the
 * address 100 percent a user choice (an explicit loopback is honored
 * because it is the explicit decision of the caller).
 *
 * @param preferred Host explicitly chosen by the caller; wins over env.
 */
export function resolveHost(preferred?: string): string {
  try {
    const fromenv = process.env.virtualenginehost ?? process.env.vhehost;
    const chosen = preferred ?? fromenv;
    if (typeof chosen !== 'string' || chosen.trim().length === 0) {
      throw new engineerror(
        'host is required: pass an explicit host or set virtualenginehost; the engine never assumes a default address',
      );
    }
    return chosen.trim();
  } catch (cause) {
    if (cause instanceof engineerror) {
      throw cause;
    }
    throw new engineerror('resolveHost failed', { cause: cause as Error });
  }
}

/**
 * Combines a host and a port into an endpoint descriptor. The port falls
 * back to randomPort when omitted so the endpoint is always concrete.
 */
export function buildEndpoint(host: string, port?: number): engineendpoint {
  try {
    const resolvedhost = resolveHost(host);
    const resolvedport = randomPort(port);
    return {
      host: resolvedhost,
      port: resolvedport,
      url: `http://${resolvedhost}:${resolvedport}`,
    };
  } catch (cause) {
    throw new engineerror('buildEndpoint failed', { cause: cause as Error });
  }
}

/* ------------------------------------------------------------------ */
/* Section 4: zod-like specification validation                        */
/* ------------------------------------------------------------------ */

/** Kinds of primitives understood by the built-in rule engine. */
export type rulekind = 'number' | 'string' | 'boolean' | 'enum';

/** One validation rule bound to a specification field. */
export type specrule = {
  readonly key: keyof enginespec;
  readonly kind: rulekind;
  readonly min?: number;
  readonly max?: number;
  readonly pattern?: RegExp;
  readonly values?: readonly string[];
  readonly optional?: boolean;
  readonly description: string;
};

/** Result of running validateSpec over a candidate specification. */
export type specvalidationresult = {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly normalized: enginespec | null;
};

/**
 * Default rule table derived from enginelimits. It behaves like a small
 * dependency-free schema: each entry describes bounds and shape for one
 * field of enginespec and validateSpec walks the table collecting errors.
 */
export const specschema: readonly specrule[] = [
  { key: 'model', kind: 'string', pattern: /\S+/, description: 'non-empty processor model name' },
  {
    key: 'vcpus',
    kind: 'number',
    min: enginelimits.minvcpu,
    max: enginelimits.maxvcpu,
    description: 'vCPU count between 1 and 192',
  },
  {
    key: 'ramgb',
    kind: 'number',
    min: enginelimits.minramgb,
    max: enginelimits.maxramgb,
    description: 'guest RAM in GB between 1 and 1024',
  },
  {
    key: 'vramgb',
    kind: 'number',
    min: enginelimits.minvramgb,
    max: enginelimits.maxvramgb,
    description: 'virtualized VRAM in GB between 8 and 96',
  },
  {
    key: 'mig',
    kind: 'enum',
    values: ['1g.24gb', '2g.48gb', '4g.96gb', 'off'],
    description: 'MIG slicing profile',
  },
  {
    key: 'runtime',
    kind: 'enum',
    values: ['qemu', 'firecracker', 'docker', 'gvisor'],
    description: 'execution backend',
  },
  {
    key: 'host',
    kind: 'string',
    pattern: /\S+/,
    description: 'user chosen bind host, never defaulted',
  },
  {
    key: 'port',
    kind: 'number',
    min: enginelimits.minport,
    max: enginelimits.maxport,
    description: 'port between 30000 and 59999',
  },
  {
    key: 'metricsintervalms',
    kind: 'number',
    min: 100,
    max: 3600000,
    description: 'sampling interval in milliseconds',
  },
];

/**
 * Validates a candidate specification against the rule table. The function
 * is zod-like in spirit but has zero external dependencies: it type-checks
 * each field, enforces numeric bounds, matches string patterns and rejects
 * unknown enum values, then returns the errors, soft warnings and a frozen
 * normalized copy when everything passes.
 *
 * @param spec Candidate specification; the const type parameter preserves
 *   literal inference for callers that pass object literals.
 */
export function validateSpec<const T extends enginespec>(spec: T): specvalidationresult {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    for (const rule of specschema) {
      const value: unknown = (spec as Record<string, unknown>)[rule.key as string];
      if (value === undefined) {
        if (rule.optional !== true) {
          errors.push(`${rule.key}: missing required field (${rule.description})`);
        }
        continue;
      }
      switch (rule.kind) {
        case 'number': {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            errors.push(`${rule.key}: expected a finite number`);
            break;
          }
          if (rule.min !== undefined && value < rule.min) {
            errors.push(`${rule.key}: ${value} is below the minimum ${rule.min}`);
          }
          if (rule.max !== undefined && value > rule.max) {
            errors.push(`${rule.key}: ${value} is above the maximum ${rule.max}`);
          }
          break;
        }
        case 'string': {
          if (typeof value !== 'string') {
            errors.push(`${rule.key}: expected a string`);
            break;
          }
          if (rule.pattern !== undefined && !rule.pattern.test(value)) {
            errors.push(`${rule.key}: fails pattern ${String(rule.pattern)} (${rule.description})`);
          }
          break;
        }
        case 'boolean': {
          if (typeof value !== 'boolean') {
            errors.push(`${rule.key}: expected a boolean`);
          }
          break;
        }
        case 'enum': {
          if (typeof value !== 'string' || rule.values?.includes(value as string) !== true) {
            errors.push(`${rule.key}: expected one of ${rule.values?.join(', ') ?? 'nothing'}`);
          }
          break;
        }
        default: {
          errors.push(`${rule.key}: unknown rule kind`);
        }
      }
    }
    if (
      typeof spec.vramgb === 'number' &&
      typeof spec.ramgb === 'number' &&
      spec.vramgb > spec.ramgb
    ) {
      warnings.push(
        'vramgb exceeds ramgb: legitimate for GPU-first layouts, confirm this is intended',
      );
    }
    if (spec.mig === 'off' && typeof spec.vramgb === 'number' && spec.vramgb >= 96) {
      warnings.push('vramgb of 96 GB without MIG slicing dedicates the whole device to one guest');
    }
    if (typeof spec.vcpus === 'number' && spec.vcpus > 64 && spec.runtime === 'firecracker') {
      warnings.push(
        'firecracker boots fastest with small vCPU counts; large counts increase restore time',
      );
    }
    if (errors.length > 0) {
      return { valid: false, errors, warnings, normalized: null };
    }
    const normalized: enginespec = {
      model: String(spec.model),
      vcpus: Number(spec.vcpus),
      ramgb: Number(spec.ramgb),
      vramgb: Number(spec.vramgb),
      mig: spec.mig,
      runtime: spec.runtime,
      host: String(spec.host),
      port: Number(spec.port),
      metricsintervalms: Number(spec.metricsintervalms),
    };
    return { valid: true, errors, warnings, normalized: Object.freeze(normalized) };
  } catch (cause) {
    return {
      valid: false,
      errors: [`validateSpec crashed: ${(cause as Error).message}`],
      warnings,
      normalized: null,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Section 5: metrics types and InternalMemory store                   */
/* ------------------------------------------------------------------ */

/** One immutable metric sample. */
export type metricssample = {
  readonly at: number;
  readonly cpuutilization: number;
  readonly memusedgb: number;
  readonly memtotalgb: number;
  readonly vramusedgb: number;
  readonly vramtotalgb: number;
  readonly iops: number;
};

/** Aggregate view over the stored samples of one engine. */
export type metricsaggregate = {
  readonly count: number;
  readonly cpuavg: number;
  readonly cpupeak: number;
  readonly memavggb: number;
  readonly newest: metricssample | null;
};

/**
 * Map-based internal memory store used by every engine instance. Gauges,
 * counters, labels and rolling samples live in plain Map containers which
 * guarantees deterministic iteration, cheap snapshots and no binding to any
 * runtime-specific global. The store also owns a WeakMap side table for
 * ephemeral probes that must never keep engines alive.
 */
export class InternalMemory {
  #gauges: Map<string, number>;
  #counters: Map<string, number>;
  #labels: Map<string, string>;
  #series: Map<string, metricssample[]>;
  #probes: WeakMap<object, metricssample>;

  constructor() {
    this.#gauges = new Map<string, number>();
    this.#counters = new Map<string, number>();
    this.#labels = new Map<string, string>();
    this.#series = new Map<string, metricssample[]>();
    this.#probes = new WeakMap<object, metricssample>();
  }

  /** Number of distinct gauges currently registered. */
  get gaugecount(): number {
    return this.#gauges.size;
  }

  /** Private accessor that folds counters and gauges into one size metric. */
  get #totalslots(): number {
    return this.#gauges.size + this.#counters.size + this.#labels.size + this.#series.size;
  }

  /** Reports how many storage slots are live across all containers. */
  get slotcount(): number {
    return this.#totalslots;
  }

  /** Sets a gauge value, creating it when missing. */
  setgauge(name: string, value: number): this {
    try {
      if (!Number.isFinite(value)) {
        throw new TypeError(`gauge ${name} must be a finite number`);
      }
      this.#gauges.set(name, value);
      return this;
    } catch (cause) {
      throw new engineerror('setgauge failed', { cause: cause as Error });
    }
  }

  /** Reads a gauge, returning the fallback when the gauge is absent. */
  readgauge(name: string, fallback = 0): number {
    return this.#gauges.get(name) ?? fallback;
  }

  /** Increments a counter by delta (default 1) and returns the new total. */
  bump(name: string, delta = 1): number {
    const next = (this.#counters.get(name) ?? 0) + delta;
    this.#counters.set(name, next);
    return next;
  }

  /** Reads a counter without mutating it. */
  readcounter(name: string): number {
    return this.#counters.get(name) ?? 0;
  }

  /** Attaches a human readable label for observability tooling. */
  setlabel(name: string, value: string): this {
    this.#labels.set(name, value);
    return this;
  }

  /** Returns a frozen copy of all labels. */
  readlabels(): Readonly<Record<string, string>> {
    return Object.freeze({ ...Object.fromEntries(this.#labels) });
  }

  /** Pushes a sample into the rolling series of one engine. */
  pushsample(engineid: string, sample: metricssample, keep = 720): number {
    try {
      const bucket = this.#series.get(engineid) ?? [];
      bucket.push(sample);
      while (bucket.length > keep) {
        bucket.shift();
      }
      this.#series.set(engineid, bucket);
      return bucket.length;
    } catch (cause) {
      throw new engineerror('pushsample failed', { cause: cause as Error });
    }
  }

  /** Computes cpu and memory averages plus peaks for one engine. */
  aggregate(engineid: string): metricsaggregate {
    const bucket = this.#series.get(engineid) ?? [];
    if (bucket.length === 0) {
      return { count: 0, cpuavg: 0, cpupeak: 0, memavggb: 0, newest: null };
    }
    let cpusum = 0;
    let cpupeak = 0;
    let memsum = 0;
    for (const sample of bucket) {
      cpusum += sample.cpuutilization;
      cpupeak = Math.max(cpupeak, sample.cpuutilization);
      memsum += sample.memusedgb;
    }
    return {
      count: bucket.length,
      cpuavg: Number((cpusum / bucket.length).toFixed(4)),
      cpupeak,
      memavggb: Number((memsum / bucket.length).toFixed(4)),
      newest: bucket[bucket.length - 1] ?? null,
    };
  }

  /** Stores an ephemeral probe keyed by a weak object reference. */
  attachprobe(owner: object, sample: metricssample): void {
    this.#probes.set(owner, sample);
  }

  /** Reads an ephemeral probe; returns null when the owner is gone. */
  readprobe(owner: object): metricssample | null {
    return this.#probes.get(owner) ?? null;
  }

  /** Drops every container, leaving the store empty but reusable. */
  clear(): void {
    this.#gauges.clear();
    this.#counters.clear();
    this.#labels.clear();
    this.#series.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Section 6: disposable MetricsStore for using declarations           */
/* ------------------------------------------------------------------ */

/**
 * Disposable metrics facade. Instances are designed for explicit resource
 * management: `using store = new MetricsStore()` flushes the snapshot to
 * disk on scope exit through Symbol.dispose, while `await using` performs
 * the same through Symbol.asyncDispose after letting pending samples
 * settle. Both disposers are idempotent so double disposal is harmless.
 * The v2 orchestrator subclasses this store (sandboxmetrics) so the whole
 * engine keeps exactly one metrics component.
 */
export class MetricsStore {
  #memory: InternalMemory;
  #engineid: string;
  #snapshotdir: string | null;
  #disposed: boolean;

  constructor(engineid: string, snapshotdir?: string) {
    this.#memory = new InternalMemory();
    this.#engineid = engineid;
    this.#snapshotdir = snapshotdir ?? null;
    this.#disposed = false;
  }

  /** Direct access to the underlying InternalMemory containers. */
  get memory(): InternalMemory {
    return this.#memory;
  }

  /** Engine identifier this store is bound to. */
  get engineid(): string {
    return this.#engineid;
  }

  /** True once a disposer has run for this instance. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Records a sample into the rolling series. */
  record(sample: metricssample): this {
    if (this.#disposed) {
      throw new engineerror('MetricsStore is disposed and cannot record');
    }
    this.#memory.pushsample(this.#engineid, sample);
    this.#memory.setgauge('lastcpu', sample.cpuutilization);
    this.#memory.setgauge('lastmemgb', sample.memusedgb);
    return this;
  }

  /** Persists the current aggregate snapshot to the configured directory. */
  flush(): string | null {
    try {
      if (this.#snapshotdir === null) {
        return null;
      }
      const aggregate = this.#memory.aggregate(this.#engineid);
      const payload = JSON.stringify(
        { engineid: this.#engineid, at: Date.now(), aggregate, labels: this.#memory.readlabels() },
        null,
        2,
      );
      mkdirSync(this.#snapshotdir, { recursive: true });
      const file = join(this.#snapshotdir, `${this.#engineid}.metrics.json`);
      writeFileSync(file, payload, 'utf8');
      return file;
    } catch (cause) {
      throw new engineerror('MetricsStore.flush failed', { cause: cause as Error });
    }
  }

  /** Loads a previously persisted snapshot, returning null when missing. */
  restore(): Record<string, unknown> | null {
    try {
      if (this.#snapshotdir === null) {
        return null;
      }
      const file = join(this.#snapshotdir, `${this.#engineid}.metrics.json`);
      const raw = readFileSync(file, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Synchronous disposer used by `using store = new MetricsStore(...)`. */
  [Symbol.dispose](): void {
    if (this.#disposed) {
      return;
    }
    try {
      this.flush();
    } catch {
      /* persistence failures must never mask scope exit */
    } finally {
      this.#disposed = true;
    }
  }

  /** Asynchronous disposer used by `await using` declarations. */
  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
  }
}

/* ------------------------------------------------------------------ */
/* Section 7: typed event bus — the single bus of the v2 merge         */
/* ------------------------------------------------------------------ */

/**
 * Map of every event topic emitted by the engine to its payload type.
 *
 * The v2 merge collapses the three buses of the pool (the v5 enginebus,
 * the Meta TypedEventBus and the Meta SaddleEventBus) into this single
 * topology: the original engine:* and metrics:* topics plus the full
 * sandbox:* and vm plane surface (vm, vcpu, vram, gpu, sriov, passage,
 * mttg, docker, qemu, health, autoscale, numa, migration, snapshot,
 * checkpoint, config, plugin, rbac, audit, leader, quota, preemption,
 * drain and system) that orchestrator.ts publishes through sandboxevents,
 * a subclass of enginebus. no second bus exists anywhere in the library.
 */
export type enginetopics = {
  readonly 'engine:created': { readonly engineid: string; readonly at: number };
  readonly 'engine:starting': { readonly engineid: string; readonly spec: enginespec };
  readonly 'engine:running': { readonly engineid: string; readonly endpoint: engineendpoint };
  readonly 'engine:stopped': { readonly engineid: string; readonly uptimems: number };
  readonly 'engine:error': { readonly engineid: string; readonly error: Error };
  readonly 'metrics:sample': { readonly engineid: string; readonly sample: metricssample };
  readonly 'engine:statechanged': {
    readonly engineid: string;
    readonly from: enginestate;
    readonly to: enginestate;
  };
  readonly 'sandbox:created': {
    readonly id: string;
    readonly runtime: string;
    readonly host: string;
    readonly ports: readonly { readonly host: number; readonly container: number }[];
  };
  readonly 'sandbox:started': {
    readonly id: string;
    readonly runtime: string;
    readonly bootms: number;
  };
  readonly 'sandbox:stopped': { readonly id: string; readonly reason: string };
  readonly 'sandbox:snapshotted': { readonly id: string; readonly file: string };
  readonly 'sandbox:restored': { readonly id: string; readonly snapshotfile: string };
  readonly 'sandbox:destroyed': { readonly id: string };
  readonly 'sandbox:pooled': { readonly size: number };
  readonly 'sandbox:error': {
    readonly id?: string;
    readonly phase: string;
    readonly message: string;
  };
  readonly 'vm:created': { readonly vmid: string; readonly tenantid: string };
  readonly 'vm:started': { readonly vmid: string; readonly pid: number };
  readonly 'vm:stopped': { readonly vmid: string; readonly reason: string };
  readonly 'vm:error': { readonly vmid: string; readonly error: string };
  readonly 'vm:phase': { readonly vmid: string; readonly to: string };
  readonly 'vcpu:scheduled': {
    readonly vmid: string;
    readonly vcpuid: string;
    readonly cpu: number;
  };
  readonly 'sched:overcommitwarn': {
    readonly vmid: string;
    readonly requested: number;
    readonly host: number;
    readonly overcommit: number;
  };
  readonly 'vram:adjusted': {
    readonly vmid: string;
    readonly targetmib: number;
    readonly actualmib: number;
  };
  readonly 'gpu:assigned': {
    readonly vmid: string;
    readonly gpuid: string;
    readonly vfid?: string;
  };
  readonly 'gpu:released': { readonly gpuid: string; readonly vmid: string };
  readonly 'sriov:vfcreated': { readonly pf: string; readonly vfid: string };
  readonly 'passage:routecreated': {
    readonly id: string;
    readonly srcvm: string;
    readonly dstvm: string;
    readonly protocol: string;
  };
  readonly 'mttg:jobdone': { readonly jobid: string; readonly durationms: number };
  readonly 'mttg:enqueued': {
    readonly jobid: string;
    readonly tenant: string;
    readonly qos: string;
  };
  readonly 'mttg:preempted': { readonly incoming: string; readonly preempted: readonly string[] };
  readonly 'docker:attached': {
    readonly vmid: string;
    readonly bridge: string;
    readonly ipv4: string;
  };
  readonly 'qemu:exit': { readonly vmid: string; readonly code: number | null };
  readonly 'qemu:versionmismatch': { readonly expected: string; readonly got: string };
  readonly 'health:change': {
    readonly checkid: string;
    readonly old: string;
    readonly new: string;
  };
  readonly 'autoscale:trigger': {
    readonly policyid: string;
    readonly action: string;
    readonly count: number;
  };
  readonly 'numa:rebalance': { readonly moves: number; readonly from: number; readonly to: number };
  readonly 'migration:progress': {
    readonly jobid: string;
    readonly vmid: string;
    readonly state: string;
    readonly progress: number;
  };
  readonly 'snapshot:created': { readonly snapshotid: string; readonly vmid: string };
  readonly 'checkpoint:created': {
    readonly checkpointid: string;
    readonly vmid: string;
    readonly method: string;
  };
  readonly 'config:reloaded': { readonly file: string };
  readonly 'plugin:loaded': { readonly pluginid: string };
  readonly 'plugin:unloaded': { readonly pluginid: string };
  readonly 'rbac:denied': { readonly userid: string; readonly action: string };
  readonly 'audit:entry': {
    readonly actor: string;
    readonly action: string;
    readonly target: string;
    readonly result: string;
  };
  readonly 'leader:changed': { readonly leader: string; readonly term: number };
  readonly 'quota:set': {
    readonly tenantid: string;
    readonly vcpu: number;
    readonly vrammib: number;
    readonly gpu: number;
  };
  readonly 'node:drained': {
    readonly labelkey: string;
    readonly labelvalue: string;
    readonly drained: readonly string[];
  };
  readonly 'system:error': { readonly kind: string; readonly message: string };
  readonly 'otel:exporterstarted': { readonly host: string; readonly port: number };
};

/** Union of all topic names; template literal types keep it extensible. */
export type enginetopicname = keyof enginetopics;

/**
 * Strongly typed observer bus built on node:events EventEmitter. Publish and
 * subscribe are generic over the topic map so listeners receive exactly the
 * payload type of the topic they choose; the underlying EventEmitter is kept
 * private so external code cannot bypass typing. This class is the single
 * bus of the engine: orchestrator.ts extends it (sandboxevents) and every
 * subsystem publishes here instead of creating its own emitter.
 */
export class enginebus {
  #emitter: EventEmitter;

  constructor() {
    this.#emitter = new EventEmitter();
    this.#emitter.setMaxListeners(0);
  }

  /** Subscribes a typed listener to one topic. */
  subscribe<t extends enginetopicname>(
    topic: t,
    listener: (payload: enginetopics[t]) => void,
  ): this {
    this.#emitter.on(topic, listener as (...args: unknown[]) => void);
    return this;
  }

  /** Removes a previously subscribed listener. */
  unsubscribe<t extends enginetopicname>(
    topic: t,
    listener: (payload: enginetopics[t]) => void,
  ): this {
    this.#emitter.off(topic, listener as (...args: unknown[]) => void);
    return this;
  }

  /** Publishes one event; the boolean mirrors EventEmitter emit results. */
  publish<t extends enginetopicname>(topic: t, payload: enginetopics[t]): boolean {
    return this.#emitter.emit(topic, payload);
  }

  /** Waits until one topic fires, resolving with its payload. */
  waitfor<t extends enginetopicname>(topic: t): Promise<enginetopics[t]> {
    return new Promise<enginetopics[t]>((resolve) => {
      this.#emitter.once(topic, (payload: enginetopics[t]) => {
        resolve(payload);
      });
    });
  }

  /** Returns how many listeners are attached to one topic. */
  listenercount(topic: enginetopicname): number {
    return this.#emitter.listenerCount(topic);
  }
}

/** Process-wide bus shared by factories in this module. */
export const engineeventbus = new enginebus();

/* ------------------------------------------------------------------ */
/* Section 8: error type and safe execution helpers                    */
/* ------------------------------------------------------------------ */

/** Error thrown by every engine subsystem with an optional cause chain. */
export class engineerror extends Error {
  /** Machine readable subsystem tag. */
  readonly subsystem: string;

  constructor(message: string, options?: { cause?: Error; subsystem?: string }) {
    super(message, options);
    this.name = 'engineerror';
    this.subsystem = options?.subsystem ?? 'core';
  }
}

/** Outcome shape returned by safecall. */
export type safeoutcome<t> =
  | { readonly ok: true; readonly value: t }
  | { readonly ok: false; readonly error: Error };

/**
 * Runs an action inside a try/catch catcher and reports the outcome as a
 * discriminated union instead of throwing, which lets library callers decide
 * how failures surface. The fallback runs only when the action throws.
 */
export function safecall<t>(label: string, action: () => t, fallback?: () => t): safeoutcome<t> {
  try {
    return { ok: true, value: action() };
  } catch (cause) {
    const error =
      cause instanceof Error
        ? cause
        : new engineerror(`safecall ${label} failed`, { cause: cause as Error });
    engineeventbus.publish('engine:error', { engineid: label, error });
    if (fallback !== undefined) {
      try {
        return { ok: true, value: fallback() };
      } catch (inner) {
        return {
          ok: false,
          error: new engineerror(`safecall ${label} fallback failed`, { cause: inner as Error }),
        };
      }
    }
    return { ok: false, error };
  }
}

/* ------------------------------------------------------------------ */
/* Section 9: snapshot, health report and engine facade                */
/* ------------------------------------------------------------------ */

/** Point-in-time snapshot of an engine. */
export type enginesnapshot = {
  readonly engineid: string;
  readonly state: enginestate;
  readonly spec: enginespec;
  readonly uptimems: number;
  readonly metrics: metricsaggregate;
  readonly versions: typeof engineversions;
};

/** Health report produced by periodic probing. */
export type healthreport = {
  readonly engineid: string;
  readonly healthy: boolean;
  readonly state: enginestate;
  readonly checks: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly detail: string;
  }[];
};

/**
 * Facade object returned by createVirtualEngine. The class keeps its state
 * machine private and exposes only intentful operations, emitting typed
 * events on every transition so orchestrators can react without polling.
 */
export class VirtualEngine {
  #id: string;
  #spec: enginespec;
  #state: enginestate;
  #memory: InternalMemory;
  #bus: enginebus;
  #createdat: number;
  #startedat: number | null;
  #endpoint: engineendpoint | null;

  constructor(spec: enginespec, bus: enginebus) {
    this.#id = randomUUID();
    this.#spec = spec;
    this.#state = 'created';
    this.#memory = new InternalMemory();
    this.#bus = bus;
    this.#createdat = Date.now();
    this.#startedat = null;
    this.#endpoint = null;
    this.#memory.setlabel('model', spec.model);
    this.#memory.setlabel('runtime', spec.runtime);
  }

  /** Unique identifier of this engine instance. */
  get id(): string {
    return this.#id;
  }

  /** Frozen specification the engine was created with. */
  get spec(): enginespec {
    return this.#spec;
  }

  /** Current lifecycle state. */
  get state(): enginestate {
    return this.#state;
  }

  /** Milliseconds elapsed since creation. */
  get uptimems(): number {
    return Date.now() - this.#createdat;
  }

  /** Endpoint after a successful start, otherwise null. */
  get endpoint(): engineendpoint | null {
    return this.#endpoint;
  }

  /** Internal metrics store of this engine. */
  get memory(): InternalMemory {
    return this.#memory;
  }

  #transition(to: enginestate): void {
    const from = this.#state;
    this.#state = to;
    this.#bus.publish('engine:statechanged', { engineid: this.#id, from, to });
  }

  /** Moves the engine to running, binding the resolved endpoint. */
  start(): engineendpoint {
    try {
      if (this.#state === 'running') {
        throw new engineerror('engine is already running');
      }
      this.#transition('starting');
      this.#bus.publish('engine:starting', { engineid: this.#id, spec: this.#spec });
      this.#endpoint = buildEndpoint(this.#spec.host, this.#spec.port);
      this.#startedat = Date.now();
      this.#memory.setgauge('port', this.#endpoint.port);
      this.#memory.bump('starts');
      this.#transition('running');
      this.#bus.publish('engine:running', { engineid: this.#id, endpoint: this.#endpoint });
      return this.#endpoint;
    } catch (cause) {
      this.#transition('degraded');
      const error =
        cause instanceof Error ? cause : new engineerror('start failed', { cause: cause as Error });
      this.#bus.publish('engine:error', { engineid: this.#id, error });
      throw error;
    }
  }

  /** Stops a running engine and publishes the measured uptime. */
  stop(): void {
    if (this.#state === 'stopped') {
      return;
    }
    const started = this.#startedat ?? this.#createdat;
    this.#memory.bump('stops');
    this.#transition('stopped');
    this.#bus.publish('engine:stopped', { engineid: this.#id, uptimems: Date.now() - started });
  }

  /** Builds an immutable snapshot of the engine state. */
  snapshot(): enginesnapshot {
    return Object.freeze({
      engineid: this.#id,
      state: this.#state,
      spec: this.#spec,
      uptimems: this.uptimems,
      metrics: this.#memory.aggregate(this.#id),
      versions: engineversions,
    });
  }

  /** Runs structural health checks over spec, state and metrics. */
  healthcheck(): healthreport {
    const checks: { name: string; passed: boolean; detail: string }[] = [];
    const validation = validateSpec(this.#spec);
    checks.push({
      name: 'spec',
      passed: validation.valid,
      detail: validation.valid
        ? 'specification passes the rule table'
        : validation.errors.join('; '),
    });
    checks.push({
      name: 'state',
      passed: this.#state === 'running' || this.#state === 'created',
      detail: `current state is ${this.#state}`,
    });
    checks.push({
      name: 'endpoint',
      passed: this.#state !== 'running' || this.#endpoint !== null,
      detail:
        this.#endpoint === null
          ? 'no endpoint bound'
          : `bound to ${this.#endpoint.host}:${this.#endpoint.port}`,
    });
    checks.push({
      name: 'samples',
      passed: true,
      detail: `${this.#memory.aggregate(this.#id).count} samples retained`,
    });
    const healthy = checks.every((check) => check.passed);
    return Object.freeze({ engineid: this.#id, healthy, state: this.#state, checks });
  }
}

/* ------------------------------------------------------------------ */
/* Section 10: registry and main factory                               */
/* ------------------------------------------------------------------ */

/** Registry of live engines keyed by engine id. */
export const engineRegistry: ReadonlyMap<string, VirtualEngine> = new Map<string, VirtualEngine>();

/** Ephemeral health probes; WeakMap keeps engines garbage collectable. */
const healthprobes = new WeakMap<VirtualEngine, healthreport>();

/**
 * Creates a fully wired virtual engine from user options. The factory
 * resolves the host (user choice only), draws a random port in the
 * 30000-59999 range when none is given, validates the merged specification
 * with validateSpec, registers the instance in engineRegistry and emits the
 * engine:created topic. Failures are converted to engineerror instances so
 * callers always see a typed cause chain.
 *
 * @param options Partial specification; only the host is mandatory because
 *   the library refuses to assume any default address.
 */
export function createVirtualEngine(options: engineoptions): VirtualEngine {
  try {
    const host = resolveHost(options.host);
    const candidate: enginespec = {
      model: options.model ?? 'AMD EPYC 9965',
      vcpus: options.vcpus ?? 8,
      ramgb: options.ramgb ?? 16,
      vramgb: options.vramgb ?? 24,
      mig: options.mig ?? '1g.24gb',
      runtime: options.runtime ?? 'qemu',
      host,
      port: randomPort(options.port),
      metricsintervalms: options.metricsintervalms ?? 1000,
    };
    const validation = validateSpec(candidate);
    if (!validation.valid || validation.normalized === null) {
      throw new engineerror(`invalid engine specification: ${validation.errors.join('; ')}`);
    }
    const engine = new VirtualEngine(validation.normalized, engineeventbus);
    (engineRegistry as Map<string, VirtualEngine>).set(engine.id, engine);
    engine.memory.setgauge('vcpus', validation.normalized.vcpus);
    engine.memory.setgauge('ramgb', validation.normalized.ramgb);
    engine.memory.setgauge('vramgb', validation.normalized.vramgb);
    engineeventbus.publish('engine:created', { engineid: engine.id, at: Date.now() });
    return engine;
  } catch (cause) {
    if (cause instanceof engineerror) {
      throw cause;
    }
    throw new engineerror('createVirtualEngine failed', { cause: cause as Error });
  }
}

/** Registers a fresh health probe for an engine and returns it. */
export function probeengine(engine: VirtualEngine): healthreport {
  const report = engine.healthcheck();
  healthprobes.set(engine, report);
  return report;
}

/** Reads the latest health probe recorded for an engine, if any. */
export function lastprobe(engine: VirtualEngine): healthreport | null {
  return healthprobes.get(engine) ?? null;
}

/** Removes an engine from the registry; returns true when it existed. */
export function disposeengine(engineid: string): boolean {
  return (engineRegistry as Map<string, VirtualEngine>).delete(engineid);
}

/* ------------------------------------------------------------------ */
/* Section 11: sampling loop helper                                    */
/* ------------------------------------------------------------------ */

/** Handle returned by startsampling; disposable for `using` blocks. */
export type samplinghandle = { readonly stop: () => void };

/**
 * Starts a periodic sampling loop that fabricates metric samples with the
 * node:crypto random generator and records them into the engine metrics
 * store, emitting a metrics:sample event per iteration. The returned handle
 * implements Symbol.dispose so it composes with `using` declarations.
 */
export function startsampling(
  engine: VirtualEngine,
  store: MetricsStore,
): samplinghandle & Disposable {
  let _tick = 0;
  const total = engine.spec.ramgb;
  const vtotal = engine.spec.vramgb;
  const timer = setInterval(() => {
    _tick += 1;
    const sample: metricssample = {
      at: Date.now(),
      cpuutilization: Number((randomInt(5, 95) + Math.random()).toFixed(4)),
      memusedgb: Number((total * (randomInt(20, 80) / 100)).toFixed(3)),
      memtotalgb: total,
      vramusedgb: Number((vtotal * (randomInt(10, 90) / 100)).toFixed(3)),
      vramtotalgb: vtotal,
      iops: randomInt(1000, 250000),
    };
    store.record(sample);
    engineeventbus.publish('metrics:sample', { engineid: engine.id, sample });
  }, engine.spec.metricsintervalms);
  const handle = {
    stop: () => {
      clearInterval(timer);
    },
    [Symbol.dispose]: () => {
      clearInterval(timer);
    },
  };
  return handle;
}

/* ------------------------------------------------------------------ */
/* Section 12: plan planner (absorbed from architect.ts)               */
/* ------------------------------------------------------------------ */

/**
 * GPU mode of a plan. this mirrors the GpuMode enum of forge.hpp (the C++
 * control plane) and stays intentionally distinct from the runtime gpu
 * assignment modes of orchestrator.ts (none/passthrough/vgpu/mdev).
 */
export type plangpumode = 'vfio' | 'vgpu' | 'mig' | 'virtio' | 'none';

/** Declarative machine plan consumed by the argv renderers below. */
export type plan = {
  readonly name: string;
  readonly cpu: string;
  readonly gpu: string;
  readonly sockets: number;
  readonly dies: number;
  readonly cores: number;
  readonly threads: 1 | 2;
  readonly vcpus: number;
  readonly memorygib: number;
  readonly vramgib: number;
  readonly overcommit: number;
  readonly gpumode: plangpumode;
  readonly mttg: boolean;
  readonly mttgthreads: number;
};

/**
 * Default plan: a desktop zen5 lab (9950X3D with two CCDs) paired with an
 * RTX 5090, 65536 multiplexed MTTG threads and a 4x cpu overcommit.
 */
export const defaultplan = {
  name: 'aether-lab',
  cpu: 'AMD Ryzen 9 9950X3D',
  gpu: 'NVIDIA GeForce RTX 5090',
  sockets: 1,
  dies: 2,
  cores: 8,
  threads: 2,
  vcpus: 16,
  memorygib: 64,
  vramgib: 32,
  overcommit: 4,
  gpumode: 'vfio',
  mttg: true,
  mttgthreads: 65536,
} as const satisfies plan;

/**
 * Returns the topology product of a plan (sockets x dies x cores x
 * threads); distinct from solvetopology of virtualcpu.ts which maps a
 * processor spec to its physical package view.
 */
export function plantopology(candidate: plan): number {
  return candidate.sockets * candidate.dies * candidate.cores * candidate.threads;
}

/**
 * Renders the lean qemu argv of a plan: maxcpus headroom, hotplug memory
 * slots (maxmem), topology-aware -smp, the mttg thread count exported
 * through -fw_cfg, and per-gpu-mode device selection. the complete
 * "turbo" argv (TDX/SEV/vfio romfile/venus) lives in buildqemucmd of
 * virtualization.ts; the runtime strategy argv lives in orchestrator.ts.
 */
export function qemuargv(candidate: plan): readonly string[] {
  const maxcpus = Math.max(candidate.vcpus, plantopology(candidate));
  const args: string[] = [
    'qemu-system-x86_64',
    '-nodefaults',
    '-machine',
    'q35,accel=kvm,kernel-irqchip=split,hpet=off',
    '-cpu',
    'host,kvm=on,l3-cache=on,topoext=on,+x2apic',
    '-smp',
    `cpus=${Math.min(candidate.vcpus, plantopology(candidate))},sockets=${candidate.sockets},dies=${candidate.dies},cores=${candidate.cores},threads=${candidate.threads},maxcpus=${maxcpus}`,
    '-m',
    `${candidate.memorygib}G,slots=4,maxmem=${Math.max(candidate.memorygib * 2, candidate.memorygib + 32)}G`,
    '-name',
    `${candidate.name},debug-threads=on`,
    '-nographic',
    '-serial',
    'mon:stdio',
    '-device',
    'virtio-balloon-pci,deflate-on-oom=on,free-page-reporting=on',
    '-device',
    'virtio-net-pci,netdev=n0,mq=on,vectors=10',
    '-netdev',
    'tap,id=n0,vhost=on,queues=4,script=no,downscript=no',
  ];
  if (candidate.gpumode === 'vfio') {
    args.push('-device', 'vfio-pci,host=01:00.0,multifunction=on,x-vga=on', '-vga', 'none');
  } else if (candidate.gpumode === 'virtio') {
    args.push('-device', 'virtio-gpu-gl,hostmem=8G,blob=on,venus=on');
  }
  if (candidate.mttg) {
    args.push('-fw_cfg', `name=opt/aetherforge/mttg,string=${candidate.mttgthreads}`);
  }
  return args;
}

/** renders the plan argv as a copy-pasteable shell command. */
export function qemucommand(candidate: plan): string {
  return qemuargv(candidate)
    .map((token) => (token.includes(' ') || token.includes(',') ? `'${token}'` : token))
    .join(' \\\n  ');
}

/**
 * renders the docker run command of a plan: cpu divided by the overcommit
 * factor, unbounded pids cgroup (--pids-limit=0) and the MTTG thread
 * budget exported through AETHER_MTTG_THREADS.
 */
export function dockerrun(candidate: plan): string {
  const cpus = (candidate.vcpus / Math.max(1, candidate.overcommit)).toFixed(2);
  return [
    `docker run --rm -it --name ${candidate.name}`,
    `  --cpus=${cpus} --memory=${candidate.memorygib}g --pids-limit=0`,
    `  -e AETHER_MTTG_THREADS=${candidate.mttgthreads}`,
    candidate.gpumode === 'none' || candidate.gpumode === 'virtio' ? '' : '  --gpus all',
    '  ghcr.io/aetherforge/runtime:5',
  ]
    .filter(Boolean)
    .join(' \\\n');
}

/** renders the vm.config.toml block of a plan. */
export function plantoml(candidate: plan): string {
  return `# generated by the saddle v6 planner
[machine]
name = "${candidate.name}"
[cpu]
model = "${candidate.cpu}"
sockets = ${candidate.sockets}
dies = ${candidate.dies}
cores = ${candidate.cores}
threads = ${candidate.threads}
vcpus = ${candidate.vcpus}
overcommit = ${candidate.overcommit}
[memory]
gib = ${candidate.memorygib}
[gpu]
model = "${candidate.gpu}"
mode = "${candidate.gpumode}"
vram_gib = ${candidate.vramgib}
[mttg]
enabled = ${candidate.mttg}
virtual_threads = ${candidate.mttgthreads}
`;
}

/**
 * lints a plan: the MTTG thread budget must cover the vCPUs, the
 * overcommit ceiling is 64x, the vCPU ceiling is 4096 and the topology
 * product must equal the vCPU count.
 */
export function planlint(candidate: plan): readonly string[] {
  const notes: string[] = [];
  if (candidate.mttg && candidate.mttgthreads < candidate.vcpus) {
    notes.push('mttg threads must cover the vcpu count');
  }
  if (candidate.overcommit > 64) {
    notes.push('overcommit ceiling is 64x');
  }
  if (candidate.vcpus > 4096) {
    notes.push('vcpu ceiling is 4096');
  }
  if (plantopology(candidate) !== candidate.vcpus) {
    notes.push(`topology product ${plantopology(candidate)} differs from vcpus ${candidate.vcpus}`);
  }
  return notes;
}

/* ------------------------------------------------------------------ */
/* Section 13: export barrel (v2 modules)                              */
/* ------------------------------------------------------------------ */

/** Re-exports the compute domain (wasm/wasmtime 48 lts, webgpu on
 * lavapipe, node 26 runtime surface, ai workload planners, wasm canary,
 * wasi:gfx, chatops, gpu ebpf telemetry, ai migration predictor). */
export * from './compute.js';
/** Re-exports the media pipeline and transcode domain (24-stage
 * pipeline, ffmpeg 7.1 NVENC p1-p7 command synthesis, createoptimal
 * encoder policy, passage ed25519+chacha20-poly1305 channel, 30
 * transcode modes). */
export * from './media.js';
export {
  bellstate,
  deutsch,
  dnacapacity,
  dnavaultdecode,
  dnavaultencode,
  ghzstate,
  grover2,
  grover3,
  opticalplan,
  qteleport,
  quantuminspiredrandom,
  quantumregistry,
  quantumsim,
  runbb84,
  rune91,
} from './quantum.js';
/** Re-exports the scheduling and allocation domain (typecheck sharding,
 * shared-memory cache, project graph, MIG/vCPU/RAM/GPU/NUMA/PCI
 * allocation, aipsched, psi lstm, tenant QoS, anomaly detector,
 * hot reload, otel, health, shutdown, plugin hooks). */
export * from './scheduler.js';
export {
  cgroupsv2slice,
  creatiersengine,
  FREEPOOL,
  githubstorage,
  LATENCYLADDER,
  npmchunkregistry,
  plannpmchunks,
  publishplan,
  rambufferbackend,
  reassembleplan,
  sqlitekv,
  sqlitel3backend,
  swapfilerecipe,
  sysctldropin,
  TIERS,
  tierserror,
  tmpfsrecipe,
  zramrecipe,
} from './tiers.js';
/** Re-exports the virtual processor bank and cpuinfo generators. */
export * from './virtualcpu.js';
/** Re-exports the gpu passthrough surface (vfio, rom dump, vgpu data). */
export * from './virtualgpu.js';
/** Re-exports the virtualization surface (qemu turbo argv, passage,
 * mttg cgroups, mttg grid, checkpoint and restore, virtualizationcore
 * bridge). */
export * from './virtualization.js';
/** Re-exports the MIG profile union declared by the memory module. */
export type { migprofileid } from './virtualmemory.js';
/** Re-exports the memory tier catalog and virtual memory manager. */
export * from './virtualmemory.js';


/* ── Section 2: the saddle domain routing barrel ── */

export * from "./foundation.js";
export * from "./isolation.js";
export * from "./virtual.js";
export * from "./execution.js";
export * from "./browser.js";
export * from "./acquisition.js";
export * from "./communication.js";
export * from "./integration.js";
export * from "./automation.js";
export * from "./intelligence.js";
export * from "./distribution.js";
export * from "./modes.js";
export * from "./operations.js";
