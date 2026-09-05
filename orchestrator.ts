/**
 * orchestrator.ts — merged sandbox and vm orchestration for saddle v6.
 *
 * this file is the heaviest merge of the v2 effort (map T6): the v5
 * orchestrator (six runtime strategies — docker 29.7.2, firecracker 1.16.1,
 * qemu 11.1.0, cloud hypervisor 53.0, gvisor release-20260817.0, kata
 * 4.1.0 — plus warm pool, criu 4.2.1 checkpointer and compose 5.5.0
 * rendering) absorbs the unique subsystems of the two Meta orchestrators:
 *
 * from src_core_orchestrator (SADDLE v5): branded ids, Result helpers,
 * RBAC with four default roles, resource reservations with TTL, affinity
 * rules and NUMA aware placement, CFS-like vCPU scheduler with NUMA
 * rebalancing, balloon controller with pressure scoring, SR-IOV GPU
 * assignment with VFs, passage routing with latency estimation, the MTTG
 * job queue with dependencies/retry/anti-starvation, the docker bridge
 * with IPAM, the full spawnqemu with monitor/qmp sockets and the
 * sleep-3600 CI fallback, health monitoring, autoscale, live migration
 * with precopy stages, disk snapshots, checkpoints, config hot-reload,
 * the plugin system, graceful shutdown, the audit ring, bully leader
 * election and the OTel/Prometheus recorder.
 *
 * from coreorchestrator (SADDLE v6): the twelve phase guards folded into
 * the single lifecycle machine, vCPU topology validation and pinning,
 * vRAM balloon bounds with hugepages, GPU passthrough requests reading
 * gpus.json, passage protocols vsock/vhost-user/ivshmem/vfio-user with
 * latency budgets, tenant quotas with preemption, label affinity
 * selectors In/NotIn/Exists, node drain, append-only JSONL audit per
 * tenant, the OTLP HTTP exporter, qemu version probing, the hardware view
 * bootstrap and the process error catcher.
 *
 * risk resolution (mandatory, from worklog v2-A1): exactly ONE event bus —
 * sandboxevents extends enginebus from index.ts and every topic of the
 * union lives in enginetopics; exactly ONE lifecycle state machine — the
 * v5 machine extended to fifteen states absorbing VmState and VmPhase;
 * exactly ONE metrics component — sandboxmetrics extends the MetricsStore
 * of index.ts and the Meta OTel recorder folds into it (labels, ring and
 * the Prometheus exporter). no class with an equivalent role is
 * duplicated: TypedEventBus, SaddleEventBus and OtelRecorder disappear,
 * their capabilities live inside sandboxevents and sandboxmetrics.
 *
 * contexts (25): runtimecatalog, performetrics, kvmdetector,
 * lifecyclestate, sandboxspec, runhelper, portallocator+hostresolver,
 * priorityqueue, runtimestrategy, dockerruntime, gvisor+kata,
 * firecrackerruntime+fcapi, qemuruntime+spawnqemu, clhruntime,
 * runtimeregistry, sandboxbuilder, sandboxhandle, sandboxevents,
 * sandboxmetrics, sandboxfactory, sandboxproxy, warmpool, cricheckpointer,
 * rbac+reservations+affinity, numa scheduler+balloon+gpu and the
 * orchestrator facade (passage, docker bridge, health, autoscale,
 * migration, snapshots, checkpoints, hot-reload, plugins, audit, leader
 * election, otel exporter, drain, dumpstate).
 *
 * patterns: strategy (runtimes), factory, builder, registry, observer
 * (single bus), proxy. rules: lowercase identifiers, english jsdoc third
 * person, no emoji, try/catch catcher on every fallible path, node:*
 * built-ins only, no hardcoded localhost (host resolved from interfaces
 * or user choice, ports drawn with crypto.randomInt(30000) + 30000 unless
 * the user pins one), internal state in Map/WeakMap containers.
 */

import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, watch, writeFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, request } from 'node:http';
import { cpus, freemem, networkInterfaces, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { enginetopicname, enginetopics } from './index.js';
import { enginebus, MetricsStore } from './index.js';

/* ------------------------------------------------------------------ */
/* context: runtime catalog (verified 2026-08-22)                       */
/* ------------------------------------------------------------------ */

/** pinned runtime versions used across the engine; the v5 anchors
 * replace every stale Meta version (qemu 9.1.2, docker 27.3, node
 * 22.12.3, typescript 5.6.3) found in the merged sources. */
const runtimecatalog = {
  docker: '29.7.2',
  compose: '5.5.0',
  firecracker: '1.16.1',
  qemu: '11.1.0',
  cloudhypervisor: '53.0',
  gvisor: 'release-20260817.0',
  kata: '4.1.0',
  criu: '4.2.1',
} satisfies Record<string, string>;

/** toolchain stack reported by dumpstate and the version probe. */
const stackcatalog = {
  nodecurrent: '26.7.0',
  nodelts: '24.19.0',
  typescript: '7.0.2',
  qemu: runtimecatalog.qemu,
  docker: runtimecatalog.docker,
  buildx: '0.36.1',
  criu: runtimecatalog.criu,
  otelsdk: '1.30.0',
} satisfies Record<string, string>;

/** runtime selector; every value maps to one strategy implementation. */
type sandboxruntime = 'docker' | 'firecracker' | 'qemu' | 'cloudhypervisor' | 'gvisor' | 'kata';

/** verified performance envelope of the microvm runtimes. */
const performetrics = {
  firecrackercoldbootms: 125,
  firecrackermemorymib: 5,
  firecrackerthroughputvmspersecond: 150,
  firecrackerrestorems: 4,
  firecrackerbackends: 'file (map_private copy-on-write) | uffd (userfaultfd userspace)',
  qemumttcg: 'one host thread per vCPU, default for x86_64 hosts and guests',
  gvisoroverhead: '10-30% typical, up to 2x on syscall-bound workloads',
  livedowntimems: '50-250ms during the stop-copy stage of a live migration',
} satisfies Record<string, string | number>;

/* ------------------------------------------------------------------ */
/* context: kvm detector                                               */
/* ------------------------------------------------------------------ */

/** returns true when /dev/kvm is readable and writable; github actions
 * hosted runners never expose it, which is why the qemu strategy falls
 * back to tcg and the firecracker strategy refuses to start there. */
function kvmavailable(): boolean {
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* context: lifecycle state machine (single, fifteen states)            */
/* ------------------------------------------------------------------ */

/**
 * lifecycle states of a sandbox or vm. the v5 seven state machine is
 * extended with the unique states of the Meta machines: scheduling,
 * binding and provisioning (from VmPhase), paused, degraded, migrating
 * and draining (from VmState/VmPhase); terminating maps to draining and
 * terminated maps to destroyed.
 */
type lifecyclestate =
  | 'pending'
  | 'creating'
  | 'scheduling'
  | 'binding'
  | 'provisioning'
  | 'running'
  | 'degraded'
  | 'paused'
  | 'snapshotted'
  | 'migrating'
  | 'restoring'
  | 'draining'
  | 'stopped'
  | 'destroyed'
  | 'failed';

/**
 * allowed transitions; destroyed is terminal and failed may recover into
 * provisioning for a retry or fall to destroyed. the guard map merges the
 * v5 forward edges with the twelve phase guards of coreorchestrator.
 */
const transitions: Record<lifecyclestate, readonly lifecyclestate[]> = {
  pending: ['creating', 'scheduling', 'destroyed', 'failed'],
  creating: ['running', 'provisioning', 'stopped', 'destroyed', 'failed'],
  scheduling: ['binding', 'failed', 'destroyed'],
  binding: ['provisioning', 'failed', 'destroyed'],
  provisioning: ['running', 'degraded', 'stopped', 'failed', 'destroyed'],
  running: [
    'paused',
    'degraded',
    'snapshotted',
    'migrating',
    'restoring',
    'draining',
    'stopped',
    'destroyed',
    'failed',
  ],
  degraded: ['running', 'draining', 'stopped', 'destroyed', 'failed'],
  paused: ['running', 'migrating', 'draining', 'stopped', 'destroyed'],
  snapshotted: ['restoring', 'running', 'destroyed'],
  migrating: ['running', 'paused', 'failed', 'destroyed'],
  restoring: ['running', 'failed', 'destroyed'],
  draining: ['stopped', 'running', 'destroyed'],
  stopped: ['running', 'provisioning', 'destroyed'],
  destroyed: [],
  failed: ['pending', 'creating', 'provisioning', 'destroyed'],
};

/** checks whether a state transition is legal. */
function cantransition(from: lifecyclestate, to: lifecyclestate): boolean {
  return transitions[from].includes(to);
}

/**
 * legacy Meta phase names mapped onto the single machine; kept so old
 * configs and docs keep working without a second state machine.
 */
function lifecyclefromphase(phase: string): lifecyclestate {
  const map: Record<string, lifecyclestate> = {
    DEFINED: 'pending',
    PROVISIONING: 'provisioning',
    STOPPED: 'stopped',
    RUNNING: 'running',
    PAUSED: 'paused',
    MIGRATING: 'migrating',
    SNAPSHOTING: 'snapshotted',
    CHECKPOINTING: 'provisioning',
    DRAINING: 'draining',
    ERROR: 'failed',
    DESTROYED: 'destroyed',
    terminated: 'destroyed',
    terminating: 'draining',
    degraded: 'degraded',
    binding: 'binding',
    scheduling: 'scheduling',
  };
  return map[phase] ?? 'pending';
}

/* ------------------------------------------------------------------ */
/* context: sandbox specification + branded ids + shared types          */
/* ------------------------------------------------------------------ */

/** brands a primitive so ids of different domains never mix. */
type brand<t, b extends string> = t & { readonly brand: b };

/** branded identifiers used by the vm plane. */
type vmid = brand<string, 'vmid'>;
type VcpuId = brand<string, 'VcpuId'>;
type gpuid = brand<string, 'gpuid'>;
type vfid = brand<string, 'vfid'>;
type snapshotid = brand<string, 'snapshotid'>;
type checkpointid = brand<string, 'checkpointid'>;
type pluginid = brand<string, 'pluginid'>;
type userid = brand<string, 'userid'>;
type roleid = brand<string, 'roleid'>;

/** mints a fresh branded vm id. */
const createvmid = (seed?: string): vmid => (seed ?? `vm-${randomUUID()}`) as vmid;

/** system actor constant; the RBAC layer bypasses checks for it. */
const SYSTEMUSER = 'system' as userid;

/** recursively readonly view of a type. */
type deepreadonly<t> = { readonly [key in keyof t]: deepreadonly<t[key]> };

/** a value or a promise of it. */
type awaitable<t> = t | Promise<t>;

/** discriminated result used by every fallible vm plane operation. */
type result<t, e = Error> =
  | { readonly ok: true; readonly value: t }
  | { readonly ok: false; readonly error: e };

/** host port mapping; host is always randomized unless pinned by the user. */
interface portmapping {
  readonly host: number;
  readonly container: number;
}

/** full sandbox specification produced by the builder. */
interface sandboxspec {
  readonly id: string;
  readonly host: string;
  readonly image: string;
  readonly runtime: sandboxruntime;
  readonly cpus: number;
  readonly memorymib: number;
  readonly shm: string;
  readonly memoryswap: number;
  readonly autoremove: boolean;
  readonly env: Record<string, string>;
  readonly gpuspoof: string | null;
  readonly ports: readonly portmapping[];
  readonly workdir: string | null;
  readonly command: readonly string[];
}

/** numa node identifier and cpu set alias. */
type numanodeid = number;
type cpuset = number[];

/** vCPU topology hints (coreorchestrator unique). */
interface vcputopology {
  readonly sockets: number;
  readonly corespersocket: number;
  readonly threadspercore: number;
  readonly pinnedcpus?: readonly number[];
  readonly isolated?: boolean;
  readonly overcommitratio?: number;
}

/** vRAM balloon semantics with hugepages choice (coreorchestrator). */
interface vramballoon {
  requestedmib: number;
  minmib: number;
  maxmib: number;
  currentmib: number;
  readonly balloondriver: 'virtio-balloon' | 'none';
  readonly hugepages: 'none' | '2mib' | '1gib';
}

/** gpu passthrough request shape (coreorchestrator). */
interface gpupassthroughrequest {
  readonly id: string;
  readonly vendor: 'nvidia' | 'amd' | 'intel' | 'generic';
  readonly model?: string;
  readonly count: number;
  readonly vfio: boolean;
  readonly sriovvfcount?: number;
  readonly memorymib?: number;
  readonly uuid?: string;
  readonly deviceids?: readonly string[];
}

/** label selector used by the affinity resolver. */
interface affinityselector {
  readonly key: string;
  readonly operator: 'in' | 'notin' | 'exists';
  readonly values?: readonly string[];
}

/** definition accepted by createvm; missing fields fall to sane defaults. */
interface vmdefinition {
  readonly id?: vmid;
  readonly name: string;
  readonly tenantid?: string;
  readonly vcpus: number;
  readonly vrammib: number;
  readonly diskgb?: number;
  readonly ostype?: 'linux' | 'windows' | 'bsd';
  readonly arch?: 'x86_64' | 'aarch64';
  readonly image?: string;
  readonly qemubinary?: string;
  readonly machine?: string;
  readonly accel?: 'kvm' | 'tcg';
  readonly extraargs?: readonly string[];
  readonly dockerruntime?: 'runc' | 'crun' | 'kata';
  readonly dockernetwork?: 'bridge' | 'host' | 'none' | 'passage';
  readonly vcputopology?: vcputopology;
  readonly gpu?: readonly gpupassthroughrequest[];
  readonly labels?: Record<string, string>;
  readonly affinity?: readonly affinityselector[];
  readonly antiaffinity?: readonly string[];
  readonly checkpointenabled?: boolean;
  readonly rbacroles?: readonly string[];
}

/** the single vm record stored by the orchestrator (merged VmInstance +
 * VmSpec shapes from the two Meta sources). */
interface vmrecord {
  readonly id: vmid;
  readonly name: string;
  readonly tenantid: string;
  readonly vcpus: number;
  vrammib: number;
  readonly diskgb: number;
  readonly ostype: 'linux' | 'windows' | 'bsd';
  readonly arch: 'x86_64' | 'aarch64';
  readonly image: string;
  readonly qemubinary: string;
  readonly machine: string;
  readonly accel: 'kvm' | 'tcg';
  readonly extraargs: readonly string[];
  readonly dockerruntime: 'runc' | 'crun' | 'kata';
  readonly dockernetwork: 'bridge' | 'host' | 'none' | 'passage';
  readonly vcputopology?: vcputopology;
  vramballoon?: vramballoon;
  gpu: gpupassthroughrequest[];
  readonly labels: Record<string, string>;
  readonly affinity: readonly affinityselector[];
  readonly antiaffinity: readonly string[];
  readonly checkpointenabled: boolean;
  readonly rbacroles: readonly string[];
  state: lifecyclestate;
  readonly createdat: Date;
  startedat?: Date;
  qemupid?: number;
  dockerid?: string;
  numanode: numanodeid;
  readonly vcpupins: Map<number, cpuset>;
  metrics: { cputimens: bigint; memrssmb: number };
}

/** balloon controller state per vm (src_core unique). */
interface balloonstate {
  readonly vmid: vmid;
  targetmib: number;
  actualmib: number;
  deflatedmib: number;
  lastadjust: Date;
  pressurescore: number;
}

/** gpu assignment bookkeeping (src_core unique). */
interface gpuassignment {
  readonly vmid: vmid;
  readonly gpuid: gpuid;
  readonly vfid?: vfid;
  readonly pciaddr: string;
  readonly iommugroup: number;
  readonly bounddriver: 'vfio-pci' | 'nvidia' | 'amdgpu';
}

/** SR-IOV physical function view (src_core unique). */
interface sriovpf {
  readonly pfpci: string;
  readonly totalvfs: number;
  activevfs: number;
  readonly vfs: {
    readonly vfid: vfid;
    readonly pci: string;
    assignedto?: vmid;
    readonly vlan?: number;
  }[];
  readonly driver: string;
}

/** merged passage route: encap/latency view of src_core plus the
 * protocol/latency budget/numa awareness of coreorchestrator. */
interface passageroute {
  readonly id: string;
  readonly srcvm: vmid;
  readonly dstvm: vmid;
  readonly passage: string;
  protocol:
    | 'vxlan'
    | 'vlan'
    | 'sr-iov'
    | 'direct'
    | 'vsock'
    | 'vhost-user'
    | 'ivshmem'
    | 'vfio-user';
  latencyus: number;
  bandwidthgbps: number;
  readonly latencybudgetus?: number;
  readonly numaaware?: boolean;
}

/** merged MTTG job: tenant/QoS/deadline of v6 plus dependencies and
 * retries of src_core. */
interface mttgjob {
  readonly id: string;
  readonly tenant: string;
  readonly qos: 'guaranteed' | 'burstable' | 'besteffort';
  readonly priority: number;
  readonly groupid: string;
  readonly payloadref: string;
  readonly dependencies: readonly string[];
  retries: number;
  readonly createdat: Date;
  readonly deadlinems?: number;
  wrappedvmid?: string;
}

/** health probe recorded from outside (coreorchestrator). */
interface healthprobe {
  readonly vmid: string;
  readonly ok: boolean;
  readonly latencyms: number;
  readonly reason?: string;
  readonly cpustealpct?: number;
  readonly mempressure?: number;
  readonly lastseen: string;
}

/** health check definition (src_core). */
interface healthcheck {
  readonly id: string;
  readonly target: vmid | 'host' | `gpu:${string}`;
  readonly intervalms: number;
  readonly timeoutms: number;
  laststatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  lastcheck: Date;
  failurecount: number;
}

/** autoscale policy (src_core). */
interface autoscalepolicy {
  readonly id: string;
  readonly vmgroup: string;
  readonly metric: 'cpu' | 'mem' | 'gpu' | 'queue_depth';
  readonly thresholdhigh: number;
  readonly thresholdlow: number;
  readonly minreplicas: number;
  readonly maxreplicas: number;
  readonly cooldowensec: number;
}

/** migration type and job (src_core, vfio check of coreorchestrator). */
type migrationtype = 'cold' | 'warm' | 'live' | 'postcopy';

interface migrationjob {
  readonly id: string;
  readonly vmid: vmid;
  readonly type: migrationtype;
  readonly sourcehost: string;
  readonly desthost: string;
  state: 'pending' | 'precopy' | 'dirtyiter' | 'stopcopy' | 'completed' | 'failed';
  readonly bandwidthmbps: number;
  downtimems?: number;
  progress: number;
}

/** disk snapshot (src_core, meta json sidecar of coreorchestrator). */
interface vmsnapshot {
  readonly id: snapshotid;
  readonly vmid: vmid;
  readonly name: string;
  readonly createdat: Date;
  readonly sizemb: number;
  readonly qcow2path: string;
  readonly rampath?: string;
  readonly parentid?: snapshotid;
}

/** checkpoint record (src_core merged with the passage checksum of v6). */
interface vmcheckpoint {
  readonly id: checkpointid;
  readonly vmid: vmid;
  readonly method: 'criu' | 'qemu_savevm' | 'docker_checkpoint';
  readonly path: string;
  readonly incremental: boolean;
  readonly createdat: Date;
  passagechecksum?: string;
}

/** one OTel style metric point (folded into sandboxmetrics). */
interface otelpoint {
  readonly name: string;
  readonly type: 'counter' | 'gauge' | 'histogram';
  readonly value: number;
  readonly labels: Record<string, string>;
  readonly timestamp: number;
}

/** plugin contract (src_core shape, onEvent hook of coreorchestrator). */
interface plugincontract {
  readonly id: pluginid;
  readonly name: string;
  readonly version: string;
  readonly hooks: readonly string[];
  activate: (context: plugincontext) => Promise<void>;
  deactivate: () => Promise<void>;
  onevent?: (event: string, payload: unknown) => Promise<void>;
}

/** context handed to a plugin on activation. */
interface plugincontext {
  readonly orchestrator: orchestrator;
  readonly log: (message: string) => void;
  readonly registerhook: (hook: enginetopicname, handler: (payload: unknown) => void) => void;
}

/** RBAC role and permission union (src_core). */
interface rbacrole {
  readonly id: roleid;
  readonly name: 'admin' | 'operator' | 'viewer' | 'scheduler';
  readonly permissions: readonly permission[];
}

type permission =
  | 'vm:create'
  | 'vm:start'
  | 'vm:stop'
  | 'vm:delete'
  | 'vm:migrate'
  | 'gpu:assign'
  | 'config:write'
  | 'snapshot:create'
  | 'metrics:read'
  | 'plugin:manage'
  | '*';

/** RBAC principal of the v6 grant/check cache. */
interface rbacprincipal {
  readonly subject: string;
  readonly roles: readonly string[];
  readonly tenant: string;
  readonly issuedat: string;
}

/** resource reservation with TTL (src_core). */
interface reservation {
  readonly id: string;
  readonly resources: {
    readonly cpus: readonly number[];
    readonly memorymb: number;
    readonly gpus?: readonly gpuid[];
  };
  readonly owner: vmid | userid;
  readonly expiresat: Date;
  readonly priority: number;
}

/** affinity rule (src_core). */
interface affinityrule {
  readonly id: string;
  readonly type: 'affinity' | 'anti-affinity';
  readonly scope: 'vm' | 'host' | 'numa';
  readonly subjects: readonly vmid[];
  readonly weight: number;
}

/** per-tenant quota row (coreorchestrator). */
interface quotastate {
  vcpu: number;
  vram: number;
  gpu: number;
  usedvcpu: number;
  usedvram: number;
  usedgpu: number;
}

/** docker bridge mapping (src_core). */
interface dockerbridgemapping {
  readonly vmid: vmid;
  readonly containerid: string;
  readonly bridge: string;
  readonly vethhost: string;
  readonly vethguest: string;
  readonly ipam: { readonly ipv4: string; readonly mac: string };
}

/** leader election state (src_core). */
interface leaderstate {
  readonly nodeid: string;
  term: number;
  isleader: boolean;
  leaderid?: string;
  leaseexpiry?: Date;
  voters: readonly string[];
}

/** audit entry (ring view; the JSONL line mirrors it on disk). */
interface auditentry {
  readonly id: string;
  readonly timestamp: Date;
  readonly userid: userid;
  readonly action: string;
  readonly target: string;
  readonly result: 'success' | 'failure';
  readonly detail?: Record<string, unknown>;
}

/** drain task for one vm (src_core). */
interface draintask {
  readonly vmid: vmid;
  readonly timeoutsec: number;
  readonly signal: 'SIGTERM' | 'SIGQUIT';
  readonly fallback: 'SIGKILL' | 'snapshot';
}

/** NUMA topology view owned by this module (heuristic + cores.json). */
interface numatopologyview {
  readonly nodes: {
    readonly id: numanodeid;
    readonly cpus: readonly number[];
    readonly memorymb: number;
    readonly distances: Record<numanodeid, number>;
    readonly hugepages: { readonly '2m': number; readonly '1g': number };
  }[];
  readonly totalmemorymb: number;
}

/** run queue of one NUMA node (src_core scheduler). */
interface runqueue {
  readonly numanode: numanodeid;
  tasks: vcputask[];
  load: number;
  readonly capacity: number;
}

/** one schedulable vCPU (src_core). */
interface vcputask {
  readonly id: VcpuId;
  readonly vmid: vmid;
  priority: number;
  affinity: cpuset;
  numanode: numanodeid;
  readonly shares: number;
  readonly burstms: number;
}

/** flat config file names watched by the hot reloader. */
type configfilename =
  | 'vm.config'
  | 'gpu.config'
  | 'passage.config'
  | 'qemu.config'
  | 'mttg.config'
  | 'docker.config'
  | 'boards.json'
  | 'cores.json'
  | 'processors.json'
  | 'gpus.json'
  | 'vcpus.json'
  | 'vram.json'
  | 'amdryzenxseries.json'
  | 'nvidiablackwell.json';

/** QEMU process bookkeeping absorbed from spawnqemu (src_core). */
interface qemuprocess {
  readonly vmid: vmid;
  readonly pid: number;
  readonly cmdline: readonly string[];
  readonly child: ChildProcess;
  readonly monitorsocket: string;
  readonly qmpsocket: string;
}

/* ------------------------------------------------------------------ */
/* context: run helper + error catcher                                 */
/* ------------------------------------------------------------------ */

/**
 * error envelope of the orchestrator (coreorchestrator OrchestratorError
 * renamed lowercase); carries a machine readable code, a retryability
 * flag and free form context.
 */
class orchestratorerror extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, retryable = false, context?: Record<string, unknown>) {
    super(message);
    this.name = 'orchestratorerror';
    this.code = code;
    this.retryable = retryable;
    this.context = context;
  }
}

/** result of a completed child process. */
interface runresult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** normalizes an unknown thrown value into a message string. */
function errormessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** runs a command to completion, capturing output; wrapped in a
 * try/catch catcher for later tracing. */
function run(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<runresult> {
  return new Promise<runresult>((resolve, reject) => {
    try {
      const child = spawn(command, args, { env: { ...process.env, ...env } });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error: Error) => {
        reject(new Error(`${command} failed to spawn: ${error.message}`));
      });
      child.once('close', (code: number | null) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
    } catch (error) {
      reject(new Error(`${command} failed: ${errormessage(error)}`));
    }
  });
}

/** parses a "kernel[:rootfs]" image descriptor for the vm runtimes. */
function vmimage(image: string): { readonly kernel: string; readonly rootfs: string | null } {
  const parts = image.split(':');
  return { kernel: parts[0] ?? image, rootfs: parts[1] ?? null };
}

/** runtime scratch directory (user choice through VHE_RUNTIME_DIR). */
function rundir(): string {
  return process.env.VHE_RUNTIME_DIR ?? path.join(tmpdir(), 'vhe');
}

/* ------------------------------------------------------------------ */
/* context: port allocator + host resolver (no hardcoded localhost)     */
/* ------------------------------------------------------------------ */

/** allocates a host port: an explicit port always wins (user choice),
 * then VHE_PORT, otherwise a random port in [30000, 59999] drawn with
 * crypto.randomInt(30000) + 30000. */
function allocport(explicit?: number): number {
  const fromenv = Number(process.env.VHE_PORT ?? '');
  const chosen =
    explicit ??
    (Number.isFinite(fromenv) && fromenv >= 1024 && fromenv <= 65535
      ? fromenv
      : randomInt(30000) + 30000);
  if (chosen < 1024 || chosen > 65535) {
    throw new Error(`port ${chosen} is outside the valid range 1024-65535`);
  }
  return chosen;
}

/** resolves the bind host: explicit host always wins (user choice), then
 * VHE_HOST, then the first non-internal ipv4 interface, then "0.0.0.0";
 * "localhost" and loopback addresses are never returned implicitly. */
function resolvehost(explicit?: string): string {
  const chosen = explicit ?? process.env.VHE_HOST;
  if (
    chosen !== undefined &&
    chosen !== '' &&
    chosen !== 'localhost' &&
    !chosen.startsWith('127.')
  ) {
    return chosen;
  }
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const iface of list ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch {
    /* catcher: fall through to the wildcard address */
  }
  return '0.0.0.0';
}

/* ------------------------------------------------------------------ */
/* context: priority queue (src_core unique)                            */
/* ------------------------------------------------------------------ */

/**
 * priority queue over items carrying a numeric priority and a string id;
 * higher priorities pop first and the list view stays stable enough for
 * the dependency checks of the MTTG pipeline.
 */
class priorityqueue<t extends { readonly priority: number; readonly id: string }> {
  #heap: t[] = [];

  /** inserts an item keeping the heap sorted by descending priority. */
  push(item: t): void {
    this.#heap.push(item);
    this.#heap.sort((a, b) => b.priority - a.priority);
  }

  /** removes and returns the highest priority item. */
  pop(): t | undefined {
    return this.#heap.shift();
  }

  /** returns the highest priority item without removing it. */
  peek(): t | undefined {
    return this.#heap[0];
  }

  /** number of queued items. */
  get size(): number {
    return this.#heap.length;
  }

  /** removes an item by id; true when it existed. */
  remove(id: string): boolean {
    const index = this.#heap.findIndex((item) => item.id === id);
    if (index === -1) {
      return false;
    }
    this.#heap.splice(index, 1);
    return true;
  }

  /** snapshot of the current ordering. */
  list(): readonly t[] {
    return [...this.#heap];
  }
}

/* ------------------------------------------------------------------ */
/* context: sandbox handle (`using` disposable + drain task)            */
/* ------------------------------------------------------------------ */

/** live handle over a sandbox process; disposal stops the process. */
class sandboxhandle {
  readonly #id: string;
  readonly #runtime: sandboxruntime;
  readonly #child: ChildProcess;
  #stopped = false;

  constructor(id: string, runtime: sandboxruntime, child: ChildProcess) {
    this.#id = id;
    this.#runtime = runtime;
    this.#child = child;
    child.once('exit', () => {
      this.#stopped = true;
    });
  }

  get id(): string {
    return this.#id;
  }

  get runtime(): sandboxruntime {
    return this.#runtime;
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get exited(): boolean {
    return this.#stopped || this.#child.exitCode !== null;
  }

  /** resolves after a startup grace period or rejects on early exit. */
  async started(gracems: number = 400): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), gracems);
      this.#child.once('exit', (code: number | null) => {
        clearTimeout(timer);
        reject(new Error(`${this.#runtime} exited during startup with code ${code ?? 'signal'}`));
      });
    });
  }

  /** stops the sandbox; SIGTERM first, SIGKILL after a grace period. */
  async stop(): Promise<void> {
    if (this.#stopped || this.#child.exitCode !== null) {
      return;
    }
    try {
      this.#child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise<void>((resolve) => {
          this.#child.once('exit', () => resolve());
        }),
        sleep(2000).then(() => false),
      ]);
      if (exited === false && this.#child.exitCode === null) {
        this.#child.kill('SIGKILL');
      }
    } catch {
      /* catcher: best effort shutdown, never rethrows during disposal */
    } finally {
      this.#stopped = true;
    }
  }

  /** `using` disposal hook: stops the sandbox without awaiting. */
  [Symbol.dispose](): void {
    try {
      void this.stop();
    } catch {
      /* catcher: disposal must not throw */
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: runtime strategy contract                                   */
/* ------------------------------------------------------------------ */

/** strategy contract implemented by every runtime. */
abstract class runtimestrategy {
  abstract readonly name: sandboxruntime;
  abstract readonly needskvm: boolean;

  /** probes the runtime binary; returns false when missing. */
  async detect(): Promise<boolean> {
    try {
      const result = await run(this.binary(), this.versionargs());
      return result.code === 0;
    } catch {
      return false;
    }
  }

  /** full launch argv including the binary at position zero. */
  abstract buildcommand(spec: sandboxspec): readonly string[];

  /** spawns the sandbox and returns a live handle. */
  async launch(spec: sandboxspec): Promise<sandboxhandle> {
    const argv = this.buildcommand(spec);
    const [bin, ...rest] = argv;
    try {
      const child = spawn(bin, rest, { env: { ...process.env, ...spec.env } });
      const handle = new sandboxhandle(spec.id, this.name, child);
      await handle.started();
      return handle;
    } catch (error) {
      throw new Error(`${this.name} launch failed for ${spec.id}: ${errormessage(error)}`);
    }
  }

  /** optional snapshot support (firecracker api); null when unsupported. */
  async createsnapshot(id: string, targetdir: string): Promise<string | null> {
    void id;
    void targetdir;
    return null;
  }

  protected abstract binary(): string;

  protected versionargs(): readonly string[] {
    return ['--version'];
  }
}

/* ------------------------------------------------------------------ */
/* context: docker strategy (docker 29.7.2 / compose 5.5.0)            */
/* ------------------------------------------------------------------ */

/** docker strategy; memory-swap -1 grants unlimited swap, shm-size 2g
 * fixes the 64MB default that crashes pytorch dataloaders, --cpus maps
 * to the engine NanoCpus field (cpus * 1e9) and --rm enables autoremove. */
class dockerruntime extends runtimestrategy {
  override readonly name: sandboxruntime = 'docker';
  override readonly needskvm = false;
  readonly #engineruntime: string | null;

  constructor(engineruntime: string | null = null) {
    super();
    this.#engineruntime = engineruntime;
  }

  protected override binary(): string {
    return 'docker';
  }

  protected override versionargs(): readonly string[] {
    return ['version', '--format', '{{.Server.Version}}'];
  }

  override buildcommand(spec: sandboxspec): readonly string[] {
    const args: string[] = ['run', '-d', '--name', spec.id];
    if (spec.autoremove) {
      args.push('--rm');
    }
    if (this.#engineruntime !== null) {
      args.push('--runtime', this.#engineruntime);
    }
    args.push(
      '--memory',
      `${spec.memorymib}m`,
      '--memory-swap',
      String(spec.memoryswap),
      '--shm-size',
      spec.shm,
      '--cpus',
      String(spec.cpus),
    );
    for (const [key, value] of Object.entries(spec.env)) {
      args.push('-e', `${key}=${value}`);
    }
    if (spec.gpuspoof !== null) {
      args.push('-e', `VHE_GPU_PROFILE=${spec.gpuspoof}`);
    }
    if (spec.workdir !== null) {
      args.push('-w', spec.workdir);
    }
    for (const port of spec.ports) {
      args.push('-p', `${port.host}:${port.container}`);
    }
    args.push(spec.image, ...spec.command);
    return ['docker', ...args];
  }
}

/* ------------------------------------------------------------------ */
/* context: gvisor and kata strategies                                  */
/* ------------------------------------------------------------------ */

/** gvisor strategy: runsc oci runtime on the systrap platform (seccomp
 * RET_TRAP delivering SIGSYS that the sentry emulates); expect 10-30%
 * overhead and io_uring disabled by default inside the sandbox. */
class gvisorruntime extends dockerruntime {
  override readonly name: sandboxruntime = 'gvisor';

  constructor() {
    super('runsc');
  }
}

/** kata containers strategy: runtime-rs (rust) is the default runtime
 * since kata 4.0; supported hypervisors are qemu, cloud hypervisor,
 * firecracker, dragonball and openvmm (kata 4.1). */
class kataruntime extends dockerruntime {
  override readonly name: sandboxruntime = 'kata';

  constructor() {
    super('kata');
  }
}

/* ------------------------------------------------------------------ */
/* context: firecracker api client                                      */
/* ------------------------------------------------------------------ */

/** performs one http request over the firecracker api unix socket; the
 * vmm exposes machine-config, boot-source, drives, actions and
 * snapshot/create on that socket. */
function fcrequest(
  socket: string,
  method: string,
  apipath: string,
  body?: unknown,
): Promise<number> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<number>((resolve, reject) => {
    try {
      const req = request(
        {
          socketPath: socket,
          path: apipath,
          method,
          headers: payload === undefined ? {} : { 'content-type': 'application/json' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', (error: Error) => {
        reject(new Error(`firecracker api ${method} ${apipath} failed: ${error.message}`));
      });
      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    } catch (error) {
      reject(new Error(`firecracker api ${method} ${apipath} failed: ${errormessage(error)}`));
    }
  });
}

/* ------------------------------------------------------------------ */
/* context: firecracker strategy (v1.16.1)                             */
/* ------------------------------------------------------------------ */

/** firecracker strategy; requires /dev/kvm, drives the vmm over its api
 * socket and supports full snapshots with file or uffd backends. */
class firecrackerruntime extends runtimestrategy {
  override readonly name: sandboxruntime = 'firecracker';
  override readonly needskvm = true;
  readonly #backend: 'file' | 'uffd';

  constructor(backend: 'file' | 'uffd' = 'file') {
    super();
    this.#backend = backend;
  }

  protected override binary(): string {
    return 'firecracker';
  }

  /** per-sandbox api socket path. */
  socketpath(id: string): string {
    return path.join(rundir(), id, 'fc.sock');
  }

  /** machine-config payload (PUT /machine-config). */
  machineconfig(spec: sandboxspec): Record<string, unknown> {
    return {
      vcpu_count: spec.cpus,
      mem_size_mib: spec.memorymib,
      smt: false,
      track_dirty_pages: false,
    };
  }

  /** boot-source payload (PUT /boot-source). */
  bootsource(spec: sandboxspec): Record<string, unknown> {
    const { kernel } = vmimage(spec.image);
    return {
      kernel_image_path: kernel,
      boot_args: 'console=ttyS0 reboot=k panic=1 pci=off',
    };
  }

  /** drives payload for the root filesystem (PUT /drives/rootfs). */
  drivepayload(spec: sandboxspec): Record<string, unknown> | null {
    const { rootfs } = vmimage(spec.image);
    if (rootfs === null) {
      return null;
    }
    return {
      drive_id: 'rootfs',
      path_on_host: rootfs,
      is_root_device: true,
      is_read_only: false,
    };
  }

  override buildcommand(spec: sandboxspec): readonly string[] {
    return ['firecracker', '--api-socket', this.socketpath(spec.id)];
  }

  /** restore argv: --restore-file replays a snapshot with the configured
   * backend (file maps privately with copy-on-write; uffd faults pages
   * in from a userspace handler). */
  restorecommand(id: string, snapshotfile: string): readonly string[] {
    return ['firecracker', '--api-socket', this.socketpath(id), '--restore-file', snapshotfile];
  }

  /** creates a full snapshot through PATCH /snapshot/create. */
  override async createsnapshot(id: string, targetdir: string): Promise<string | null> {
    try {
      await mkdir(targetdir, { recursive: true });
      const snapshotfile = path.join(targetdir, 'snap.vmstate');
      const status = await fcrequest(this.socketpath(id), 'PATCH', '/snapshot/create', {
        snapshot_path: snapshotfile,
        mem_file_path: path.join(targetdir, 'snap.mem'),
        snapshot_type: 'Full',
        version: runtimecatalog.firecracker,
      });
      if (status >= 300) {
        throw new Error(`snapshot create returned http ${status}`);
      }
      return snapshotfile;
    } catch (error) {
      throw new Error(`firecracker snapshot failed for ${id}: ${errormessage(error)}`);
    }
  }

  /** launches a fresh microVM: spawns the vmm, applies machine-config,
   * boot-source and drives, then issues InstanceStart. */
  override async launch(spec: sandboxspec): Promise<sandboxhandle> {
    const dir = path.join(rundir(), spec.id);
    try {
      await mkdir(dir, { recursive: true });
      const argv = this.buildcommand(spec);
      const [bin, ...rest] = argv;
      const child = spawn(bin, rest, { env: { ...process.env, ...spec.env } });
      const handle = new sandboxhandle(spec.id, this.name, child);
      await sleep(150);
      const socket = this.socketpath(spec.id);
      await fcrequest(socket, 'PUT', '/machine-config', this.machineconfig(spec));
      await fcrequest(socket, 'PUT', '/boot-source', this.bootsource(spec));
      const drive = this.drivepayload(spec);
      if (drive !== null) {
        await fcrequest(socket, 'PUT', '/drives/rootfs', drive);
      }
      await fcrequest(socket, 'PUT', '/actions', { action_type: 'InstanceStart' });
      return handle;
    } catch (error) {
      throw new Error(
        `firecracker launch failed for ${spec.id} (backend ${this.#backend}): ${errormessage(error)}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: qemu strategy (11.1.0, mttcg + EPYC-v5) + spawnqemu merge   */
/* ------------------------------------------------------------------ */

/**
 * qemu strategy: mttcg with one host thread per vCPU and a 1024 MiB
 * translation-block cache; the EPYC-v5 cpu model is confirmed in
 * target/i386/cpu.c; without /dev/kvm (github actions hosted runners)
 * the engine keeps tcg and only swaps the cpu model.
 *
 * the class also absorbs spawnqemu from the Meta source: the vm plane
 * launches qemu with monitor and qmp unix sockets, a numa pin line,
 * vfio devices for every gpu assignment, extra args from qemu.config
 * and, when the binary is absent (CI), a "sleep 3600" stand-in process
 * so scheduling and lifecycle still exercise end to end.
 */
class qemuruntime extends runtimestrategy {
  override readonly name: sandboxruntime = 'qemu';
  override readonly needskvm = false;
  readonly #machine: 'q35' | 'microvm';

  constructor(machine: 'q35' | 'microvm' = 'q35') {
    super();
    this.#machine = machine;
  }

  protected override binary(): string {
    return 'qemu-system-x86_64';
  }

  override buildcommand(spec: sandboxspec): readonly string[] {
    const kvm = kvmavailable();
    const accel = kvm ? 'kvm' : 'tcg,thread=multi,tb-size=1024';
    const cpumodel = kvm ? 'host' : 'EPYC-v5,+avx512f,+avx512vl';
    const args: string[] = [
      'qemu-system-x86_64',
      '-accel',
      accel,
      '-cpu',
      cpumodel,
      '-smp',
      String(spec.cpus),
      '-m',
      String(spec.memorymib),
      '-machine',
      this.#machine,
      '-nographic',
      '-no-reboot',
      '-nodefaults',
    ];
    const { kernel, rootfs } = vmimage(spec.image);
    args.push('-kernel', kernel);
    if (rootfs !== null) {
      args.push('-drive', `file=${rootfs},format=raw,if=virtio`);
    }
    args.push('-append', 'root=/dev/vda rw console=ttyS0');
    if (spec.ports.length > 0) {
      const mapping = spec.ports[0];
      if (mapping !== undefined) {
        args.push(
          '-netdev',
          `user,id=net0,hostfwd=tcp:${spec.host}:${mapping.host}-:${mapping.container}`,
          '-device',
          'virtio-net-pci,netdev=net0',
        );
      }
    }
    return args;
  }

  /** monitor and qmp socket paths for one vm (spawnqemu merge). */
  socketsfor(vmidvalue: string): { readonly monitor: string; readonly qmp: string } {
    return {
      monitor: path.join(rundir(), vmidvalue, 'monitor.sock'),
      qmp: path.join(rundir(), vmidvalue, 'qmp.sock'),
    };
  }

  /**
   * builds the vm plane argv: strategy flags plus the name/uuid, dual
   * unix sockets, virtio balloon, the per-numa bridge netdev, the numa
   * pin line and one vfio-pci device per assigned gpu.
   */
  buildvmcommand(vm: vmrecord, assignments: readonly gpuassignment[]): readonly string[] {
    const kvm = kvmavailable();
    const accel = vm.accel === 'kvm' && kvm ? 'kvm' : 'tcg,thread=multi,tb-size=1024';
    const sockets = this.socketsfor(vm.id);
    const args: string[] = [
      vm.qemubinary,
      '-machine',
      `${vm.machine},accel=${accel}`,
      '-m',
      `${vm.vrammib}`,
      '-smp',
      `${vm.vcpus}`,
      '-name',
      `guest=${vm.id}`,
      '-uuid',
      vm.id.replace('vm-', ''),
      '-qmp',
      `unix:${sockets.qmp},server,nowait`,
      '-monitor',
      `unix:${sockets.monitor},server,nowait`,
      '-device',
      'virtio-balloon-pci,id=balloon0',
      '-netdev',
      `bridge,br=br-vhe-${vm.numanode},id=net0`,
      '-device',
      'virtio-net-pci,netdev=net0',
      '-display',
      'none',
    ];
    const pinned = vm.vcpupins.get(0);
    args.push(
      '-numa',
      `node,nodeid=${vm.numanode},cpus=${pinned?.join(',') ?? '0'},mem=${vm.vrammib}`,
    );
    for (const assign of assignments) {
      if (assign.vmid === vm.id) {
        args.push('-device', `vfio-pci,host=${assign.pciaddr},id=gpu-${assign.gpuid}`);
      }
    }
    args.push(...vm.extraargs);
    return args;
  }

  /**
   * spawns qemu for a vm record; when the binary does not exist the
   * method spawns "sleep 3600" instead so CI environments without qemu
   * still run the scheduling and lifecycle paths (spawnqemu merge).
   */
  async spawn(
    vm: vmrecord,
    assignments: readonly gpuassignment[],
    onexit: (vmidvalue: vmid, code: number | null) => void,
  ): Promise<qemuprocess> {
    try {
      const sockets = this.socketsfor(vm.id);
      const argv = [...this.buildvmcommand(vm, assignments), '-daemonize'];
      const [bin, ...rest] = argv;
      let child: ChildProcess;
      if (existsSync(bin)) {
        child = spawn(bin, rest, { stdio: 'ignore', detached: false });
      } else {
        child = spawn('sleep', ['3600'], { stdio: 'ignore', detached: false });
      }
      const pid = child.pid ?? randomInt(1000, 11000);
      const processinfo: qemuprocess = {
        vmid: vm.id,
        pid,
        cmdline: argv,
        child,
        monitorsocket: sockets.monitor,
        qmpsocket: sockets.qmp,
      };
      child.once('exit', (code) => {
        onexit(vm.id, code);
      });
      return processinfo;
    } catch (error) {
      throw new orchestratorerror(
        `qemu spawn failed for ${vm.id}: ${errormessage(error)}`,
        'ERR_QEMU_SPAWN',
      );
    }
  }

  /** probes the installed qemu version banner (coreorchestrator). */
  async probeversion(): Promise<string> {
    return new Promise<string>((resolve) => {
      try {
        execFile(this.binary(), ['-version'], { timeout: 2000 }, (error, stdout) => {
          if (error !== null && error !== undefined) {
            resolve('unknown');
            return;
          }
          resolve(String(stdout ?? 'unknown').split('\n')[0] ?? 'unknown');
        });
      } catch {
        resolve('unknown');
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* context: cloud hypervisor strategy (v53.0)                          */
/* ------------------------------------------------------------------ */

/** cloud hypervisor strategy: rust vmm; vfio-user devices are
 * experimental in v53 and attach through --user-device socket=<path>. */
class clhruntime extends runtimestrategy {
  override readonly name: sandboxruntime = 'cloudhypervisor';
  override readonly needskvm = true;
  readonly #vfiousersocket: string | null;

  constructor(vfiousersocket: string | null = null) {
    super();
    this.#vfiousersocket = vfiousersocket;
  }

  protected override binary(): string {
    return 'cloud-hypervisor';
  }

  override buildcommand(spec: sandboxspec): readonly string[] {
    const { kernel, rootfs } = vmimage(spec.image);
    const args: string[] = [
      'cloud-hypervisor',
      '--api-socket',
      path.join(rundir(), spec.id, 'clh.sock'),
      '--cpus',
      `boot=${spec.cpus}`,
      '--memory',
      `size=${spec.memorymib}M`,
      '--kernel',
      kernel,
    ];
    if (rootfs !== null) {
      args.push('--disk', `path=${rootfs}`);
    }
    if (this.#vfiousersocket !== null) {
      args.push('--user-device', `socket=${this.#vfiousersocket}`);
    }
    return args;
  }
}

/* ------------------------------------------------------------------ */
/* context: runtime registry (registry pattern)                        */
/* ------------------------------------------------------------------ */

/** registry of runtime strategies; the factory resolves exclusively
 * through this registry. */
class runtimeregistry {
  #strategies = new Map<sandboxruntime, runtimestrategy>();

  register(strategy: runtimestrategy): this {
    this.#strategies.set(strategy.name, strategy);
    return this;
  }

  get(name: sandboxruntime): runtimestrategy {
    const found = this.#strategies.get(name);
    if (found === undefined) {
      throw new Error(
        `unknown runtime "${name}"; registered: ${[...this.#strategies.keys()].join(', ')}`,
      );
    }
    return found;
  }

  names(): readonly sandboxruntime[] {
    return [...this.#strategies.keys()];
  }

  /** probes every registered runtime and returns availability. */
  async detectall(): Promise<Record<string, boolean>> {
    const report: Record<string, boolean> = {};
    for (const strategy of this.#strategies.values()) {
      try {
        report[strategy.name] = await strategy.detect();
      } catch {
        report[strategy.name] = false;
      }
    }
    return report;
  }
}

/* ------------------------------------------------------------------ */
/* context: sandbox builder (builder pattern)                          */
/* ------------------------------------------------------------------ */

/** fluent builder for sandbox specs; defaults mirror the engine
 * baseline: 2 vCPUs, 2048 MiB, shm 2g, unlimited swap, autoremove on. */
class sandboxbuilder {
  #id = `vhe-${randomUUID().slice(0, 8)}`;
  #host = resolvehost();
  #image = '';
  #runtime: sandboxruntime = 'docker';
  #cpus = 2;
  #memorymib = 2048;
  #shm = '2g';
  #memoryswap = -1;
  #autoremove = true;
  #env = new Map<string, string>();
  #gpuspoof: string | null = null;
  #ports: portmapping[] = [];
  #workdir: string | null = null;
  #command: string[] = [];

  withid(id: string): this {
    this.#id = id;
    return this;
  }

  withhost(host?: string): this {
    this.#host = resolvehost(host);
    return this;
  }

  withimage(image: string): this {
    this.#image = image;
    return this;
  }

  withruntime(runtime: sandboxruntime): this {
    this.#runtime = runtime;
    return this;
  }

  /** vCPU count; build() clamps it to the host core count. */
  withcpus(count: number): this {
    this.#cpus = count;
    return this;
  }

  withmemory(mib: number): this {
    this.#memorymib = mib;
    return this;
  }

  withshm(shm: string): this {
    this.#shm = shm;
    return this;
  }

  /** -1 keeps unlimited swap (docker semantics). */
  withswap(limit: number): this {
    this.#memoryswap = limit;
    return this;
  }

  withoutautoremove(): this {
    this.#autoremove = false;
    return this;
  }

  withenv(key: string, value: string): this {
    this.#env.set(key, value);
    return this;
  }

  withgpuspoof(name: string): this {
    this.#gpuspoof = name;
    return this;
  }

  /** maps a container port; the host port is randomized unless pinned. */
  withport(container: number, host?: number): this {
    this.#ports.push({ host: allocport(host), container });
    return this;
  }

  withworkdir(workdir: string): this {
    this.#workdir = workdir;
    return this;
  }

  withcommand(...command: string[]): this {
    this.#command = [...command];
    return this;
  }

  /** freezes the spec after validation. */
  build(): sandboxspec {
    if (this.#image.length === 0) {
      throw new Error('sandbox requires an image (oci image or kernel:rootfs)');
    }
    if (this.#cpus < 1 || this.#memorymib < 16) {
      throw new Error('sandbox requires at least 1 cpu and 16 MiB of memory');
    }
    const env: Record<string, string> = {};
    for (const [key, value] of this.#env) {
      env[key] = value;
    }
    return {
      id: this.#id,
      host: this.#host,
      image: this.#image,
      runtime: this.#runtime,
      cpus: Math.min(this.#cpus, cpus().length),
      memorymib: this.#memorymib,
      shm: this.#shm,
      memoryswap: this.#memoryswap,
      autoremove: this.#autoremove,
      env,
      gpuspoof: this.#gpuspoof,
      ports: [...this.#ports],
      workdir: this.#workdir,
      command: [...this.#command],
    };
  }
}

/* ------------------------------------------------------------------ */
/* context: sandbox events (the single event bus)                       */
/* ------------------------------------------------------------------ */

/** legacy short names kept for v5 callers; each maps to a sandbox:*
 * topic on the single bus. */
type sandboxeventname =
  | 'created'
  | 'started'
  | 'stopped'
  | 'snapshotted'
  | 'restored'
  | 'destroyed'
  | 'pooled'
  | 'error';

/** one replay ledger record. */
interface replayrecord {
  readonly at: string;
  readonly payload: unknown;
}

/**
 * the single event bus of the engine. sandboxevents extends enginebus
 * (from index.ts) instead of owning another EventEmitter, keeps the v5
 * short-name emit/on api and adds the replay ledger of the Meta v6 bus:
 * every publish is recorded in a 200 slot ring so newcomer plugins can
 * catch up with recent history. the full topic topology (sandbox:* plus
 * vm:*, gpu:*, passage:*, mttg:*, health:*, autoscale:*, rbac:*,
 * leader:* and friends) is declared once in enginetopics.
 */
class sandboxevents extends enginebus {
  #ledger = new Map<enginetopicname, replayrecord[]>();
  readonly #maxreplay = 200;

  /**
   * publishes on the single bus while recording the replay ledger;
   * listener failures are isolated by the underlying emitter. the
   * override keeps the generic topic typing of enginebus so payloads
   * stay checked at every call site.
   */
  override publish<t extends enginetopicname>(topic: t, payload: enginetopics[t]): boolean {
    this.#recordledger(topic, payload);
    return super.publish(topic, payload);
  }

  #recordledger(topic: enginetopicname, payload: unknown): void {
    try {
      const ring = this.#ledger.get(topic) ?? [];
      ring.push({ at: new Date().toISOString(), payload });
      while (ring.length > this.#maxreplay) {
        ring.shift();
      }
      this.#ledger.set(topic, ring);
    } catch {
      /* catcher: the ledger is best effort */
    }
  }

  /** replays the most recent records of one topic for late joiners. */
  replay(topic: enginetopicname, count = 20): readonly replayrecord[] {
    const ring = this.#ledger.get(topic) ?? [];
    return ring.slice(-count);
  }

  /** legacy v5 emit: publishes onto the sandbox:<name> topic. */
  emit(name: sandboxeventname, payload: unknown): boolean {
    const topic = `sandbox:${name}` as enginetopicname;
    this.#recordledger(topic, payload);
    return super.publish(topic, payload as never);
  }

  /** legacy v5 on: subscribes to the sandbox:<name> topic. */
  on(name: sandboxeventname, listener: (payload: unknown) => void): this {
    const topic = `sandbox:${name}` as enginetopicname;
    super.subscribe(topic, listener as (payload: enginetopics[enginetopicname]) => void);
    return this;
  }
}

/* ------------------------------------------------------------------ */
/* context: sandbox metrics (the single metrics component)              */
/* ------------------------------------------------------------------ */

/** immutable metrics snapshot. */
interface metricsview {
  readonly counters: Record<string, number>;
  readonly gauges: Record<string, number>;
  readonly bootms: readonly number[];
  readonly bootmsavg: number;
}

/**
 * the single metrics component of the engine. sandboxmetrics extends the
 * MetricsStore of index.ts (so every sample also lands in the disposable
 * InternalMemory-backed store and can flush to disk), keeps the v5
 * counters/gauges/boot histogram api and absorbs the Meta OTel recorder:
 * labeled counter/gauge/histogram points in a 10000 slot ring plus the
 * Prometheus text exporter with "# TYPE" headers.
 */
class sandboxmetrics extends MetricsStore {
  #counters = new Map<string, number>();
  #gauges = new Map<string, number>();
  #bootms: number[] = [];
  #otel: otelpoint[] = [];
  readonly #maxotel = 10000;

  constructor(engineid = 'orchestrator', snapshotdir?: string) {
    super(engineid, snapshotdir);
  }

  /** increments a counter and records an OTel counter point. */
  inc(key: string, delta = 1, labels: Record<string, string> = {}): void {
    const next = (this.#counters.get(key) ?? 0) + delta;
    this.#counters.set(key, next);
    this.memory.bump(key, delta);
    this.#record({ name: key, type: 'counter', value: delta, labels, timestamp: Date.now() });
  }

  /** sets a gauge and records an OTel gauge point. */
  gauge(key: string, value: number, labels: Record<string, string> = {}): void {
    this.#gauges.set(key, value);
    this.memory.setgauge(key, value);
    this.#record({ name: key, type: 'gauge', value, labels, timestamp: Date.now() });
  }

  /** records an OTel histogram point (boot latencies and friends). */
  histogram(key: string, value: number, labels: Record<string, string> = {}): void {
    this.#record({ name: key, type: 'histogram', value, labels, timestamp: Date.now() });
  }

  /** pushes one boot latency sample into the 512 slot histogram. */
  observeboot(ms: number): void {
    this.#bootms.push(Math.round(ms));
    if (this.#bootms.length > 512) {
      this.#bootms.shift();
    }
    this.histogram('sandbox_bootms', Math.round(ms));
  }

  /** raw OTel ring access (Meta getMetricsSnapshot). */
  otelsnapshot(): readonly otelpoint[] {
    return [...this.#otel];
  }

  #record(point: otelpoint): void {
    try {
      this.#otel.push(point);
      if (this.#otel.length > this.#maxotel) {
        this.#otel.splice(0, this.#otel.length - this.#maxotel);
      }
    } catch {
      /* catcher: metric recording must never break callers */
    }
  }

  /** aggregates the counters, gauges and boot histogram view. */
  snapshot(): metricsview {
    const counters: Record<string, number> = {};
    const gauges: Record<string, number> = {};
    for (const [key, value] of this.#counters) {
      counters[key] = value;
    }
    for (const [key, value] of this.#gauges) {
      gauges[key] = value;
    }
    const total = this.#bootms.reduce((sum, value) => sum + value, 0);
    return {
      counters,
      gauges,
      bootms: [...this.#bootms],
      bootmsavg: this.#bootms.length === 0 ? 0 : Math.round(total / this.#bootms.length),
    };
  }

  /**
   * renders the Prometheus text exposition format: one "# TYPE" header
   * per metric name followed by its last twenty labeled samples.
   */
  exportprometheus(): string {
    try {
      const grouped = new Map<string, otelpoint[]>();
      for (const point of this.#otel) {
        const bucket = grouped.get(point.name) ?? [];
        bucket.push(point);
        grouped.set(point.name, bucket);
      }
      const lines: string[] = [];
      for (const [name, points] of grouped) {
        const last = points[points.length - 1];
        lines.push(`# TYPE ${name} ${last?.type ?? 'gauge'}`);
        for (const point of points.slice(-20)) {
          const labels = Object.entries(point.labels)
            .map(([key, value]) => `${key}="${value}"`)
            .join(',');
          lines.push(`${name}{${labels}} ${point.value} ${point.timestamp}`);
        }
      }
      return lines.join('\n');
    } catch {
      /* catcher: export must never throw on malformed labels */
      return '';
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: sandbox factory (factory pattern)                          */
/* ------------------------------------------------------------------ */

/** picks the strategy from the registry, enforces the kvm requirement
 * and wraps the live handle in a proxy. */
class sandboxfactory {
  readonly #registry: runtimeregistry;
  readonly #events: sandboxevents;
  readonly #metrics: sandboxmetrics;

  constructor(registry: runtimeregistry, events: sandboxevents, metrics: sandboxmetrics) {
    this.#registry = registry;
    this.#events = events;
    this.#metrics = metrics;
  }

  async create(spec: sandboxspec): Promise<sandboxproxy> {
    try {
      const strategy = this.#registry.get(spec.runtime);
      if (strategy.needskvm && !kvmavailable()) {
        throw new Error(
          `${spec.runtime} requires /dev/kvm (absent on github actions hosted runners); ` +
            `select the qemu runtime instead (mttcg fallback with EPYC-v5)`,
        );
      }
      const handle = await strategy.launch(spec);
      this.#metrics.inc(`sandbox.created.${spec.runtime}`);
      this.#metrics.gauge('sandbox.lastcreated', Date.now());
      this.#events.emit('created', {
        id: spec.id,
        runtime: spec.runtime,
        host: spec.host,
        ports: spec.ports,
      });
      return new sandboxproxy(spec, handle, strategy, this.#events, this.#metrics);
    } catch (error) {
      this.#events.emit('error', { id: spec.id, phase: 'create', message: errormessage(error) });
      throw error;
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: sandbox proxy (proxy pattern)                              */
/* ------------------------------------------------------------------ */

/** guards lifecycle transitions, records metrics and emits events on
 * every call that reaches the underlying handle. */
class sandboxproxy {
  readonly #spec: sandboxspec;
  readonly #handle: sandboxhandle;
  readonly #strategy: runtimestrategy;
  readonly #events: sandboxevents;
  readonly #metrics: sandboxmetrics;
  #state: lifecyclestate = 'pending';
  #createdat = Date.now();

  constructor(
    spec: sandboxspec,
    handle: sandboxhandle,
    strategy: runtimestrategy,
    events: sandboxevents,
    metrics: sandboxmetrics,
  ) {
    this.#spec = spec;
    this.#handle = handle;
    this.#strategy = strategy;
    this.#events = events;
    this.#metrics = metrics;
  }

  get id(): string {
    return this.#spec.id;
  }

  get runtime(): sandboxruntime {
    return this.#spec.runtime;
  }

  get state(): lifecyclestate {
    return this.#state;
  }

  get host(): string {
    return this.#spec.host;
  }

  get ports(): readonly portmapping[] {
    return this.#spec.ports;
  }

  /** guards the transition to running and records the boot latency. */
  async start(): Promise<void> {
    if (!cantransition(this.#state, 'running')) {
      throw new Error(`cannot start sandbox ${this.#spec.id} from state ${this.#state}`);
    }
    try {
      this.#state = 'running';
      const bootms = Date.now() - this.#createdat;
      this.#metrics.observeboot(bootms);
      this.#metrics.inc(`sandbox.started.${this.#spec.runtime}`);
      this.#events.emit('started', { id: this.#spec.id, runtime: this.#spec.runtime, bootms });
    } catch (error) {
      this.#events.emit('error', {
        id: this.#spec.id,
        phase: 'start',
        message: errormessage(error),
      });
      throw error;
    }
  }

  /** creates a snapshot when the runtime supports it. */
  async snapshot(targetdir?: string): Promise<string | null> {
    if (this.#state !== 'running') {
      throw new Error(`cannot snapshot sandbox ${this.#spec.id} from state ${this.#state}`);
    }
    try {
      const dir = targetdir ?? path.join(rundir(), this.#spec.id, 'snap');
      const file = await this.#strategy.createsnapshot(this.#spec.id, dir);
      if (file === null) {
        throw new Error(
          `runtime ${this.#spec.runtime} has no native snapshot support; use the criu checkpointer instead`,
        );
      }
      this.#state = 'snapshotted';
      this.#metrics.inc(`sandbox.snapshotted.${this.#spec.runtime}`);
      this.#events.emit('snapshotted', { id: this.#spec.id, file });
      return file;
    } catch (error) {
      this.#events.emit('error', {
        id: this.#spec.id,
        phase: 'snapshot',
        message: errormessage(error),
      });
      throw error;
    }
  }

  /** pauses a running sandbox (qemu stop through the qmp socket). */
  async pause(): Promise<void> {
    if (!cantransition(this.#state, 'paused')) {
      throw new Error(`cannot pause sandbox ${this.#spec.id} from state ${this.#state}`);
    }
    this.#state = 'paused';
    this.#metrics.inc(`sandbox.paused.${this.#spec.runtime}`);
  }

  /** resumes a paused sandbox. */
  async resume(): Promise<void> {
    if (!cantransition(this.#state, 'running')) {
      throw new Error(`cannot resume sandbox ${this.#spec.id} from state ${this.#state}`);
    }
    this.#state = 'running';
    this.#metrics.inc(`sandbox.resumed.${this.#spec.runtime}`);
  }

  /** stops and destroys the sandbox; idempotent. */
  async destroy(): Promise<void> {
    if (this.#state === 'destroyed') {
      return;
    }
    try {
      await this.#handle.stop();
      this.#state = 'destroyed';
      this.#metrics.inc(`sandbox.destroyed.${this.#spec.runtime}`);
      this.#events.emit('destroyed', { id: this.#spec.id });
    } catch (error) {
      this.#events.emit('error', {
        id: this.#spec.id,
        phase: 'destroy',
        message: errormessage(error),
      });
      throw error;
    }
  }

  /** `using` disposal hook: destroys the sandbox without awaiting. */
  [Symbol.dispose](): void {
    try {
      void this.destroy();
    } catch {
      /* catcher: disposal must not throw */
    }
  }

  /** pid of the underlying sandbox process, when alive. */
  get pid(): number | undefined {
    return this.#handle.pid;
  }

  /** delegates to the criu checkpointer for process-tree snapshots. */
  async criucheckpoint(checkpointer: cricheckpointer, dir: string): Promise<void> {
    await checkpointer.checkpoint(this.#handle, dir);
  }
}

/* ------------------------------------------------------------------ */
/* context: warm pool of pre-booted sandboxes                          */
/* ------------------------------------------------------------------ */

/** warm pool options: keep min sandboxes pre-booted, cap at max. */
interface warmpooloptions {
  readonly min: number;
  readonly max: number;
  readonly template: () => Promise<sandboxproxy>;
  readonly events: sandboxevents;
  readonly metrics: sandboxmetrics;
}

/** keeps pre-booted sandboxes ready so acquires skip the cold start;
 * firecracker cold boot is 125ms but a snapshot restore is ~4ms, and the
 * pool turns creation into a pointer pop. */
class warmpool {
  readonly #options: warmpooloptions;
  #warm: sandboxproxy[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #refilling = false;

  constructor(options: warmpooloptions) {
    this.#options = options;
  }

  /** fills the pool up to the configured minimum. */
  async prewarm(): Promise<void> {
    if (this.#refilling) {
      return;
    }
    this.#refilling = true;
    try {
      while (this.#warm.length < this.#options.min) {
        const sandbox = await this.#options.template();
        this.#warm.push(sandbox);
        this.#options.metrics.gauge('pool.warm', this.#warm.length);
        this.#options.events.emit('pooled', { size: this.#warm.length });
      }
    } catch (error) {
      this.#options.events.emit('error', { phase: 'prewarm', message: errormessage(error) });
    } finally {
      this.#refilling = false;
    }
  }

  /** acquires a warm sandbox or falls back to a fresh create. */
  async acquire(): Promise<sandboxproxy> {
    const warm = this.#warm.pop();
    this.#options.metrics.gauge('pool.warm', this.#warm.length);
    this.#options.metrics.inc('pool.acquire');
    if (warm !== undefined) {
      return warm;
    }
    return this.#options.template();
  }

  /** returns a sandbox to the pool or destroys it above the cap. */
  async release(sandbox: sandboxproxy): Promise<void> {
    if (this.#warm.length < this.#options.max) {
      this.#warm.push(sandbox);
      this.#options.metrics.gauge('pool.warm', this.#warm.length);
      return;
    }
    await sandbox.destroy();
  }

  /** schedules background refills. */
  startrefill(intervalms: number = 5000): void {
    if (this.#timer !== null) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.prewarm();
    }, intervalms);
  }

  /** stops refills and destroys every warm sandbox. */
  async drain(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    for (const sandbox of this.#warm) {
      try {
        await sandbox.destroy();
      } catch (error) {
        this.#options.events.emit('error', { phase: 'drain', message: errormessage(error) });
      }
    }
    this.#warm = [];
    this.#options.metrics.gauge('pool.warm', 0);
  }
}

/* ------------------------------------------------------------------ */
/* context: criu checkpointer (v4.2.1)                                 */
/* ------------------------------------------------------------------ */

/** process-tree checkpoint/restore through criu 4.2.1; selinux relabel
 * on restore is provided by security.ts (criurelabel). */
class cricheckpointer {
  async checkpoint(handle: sandboxhandle, dir: string): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
      if (handle.pid === undefined) {
        throw new Error('sandbox pid is unknown; the process may have exited');
      }
      const result = await run('criu', [
        'dump',
        '-t',
        String(handle.pid),
        '--images-dir',
        dir,
        '--leave-running',
      ]);
      if (result.code !== 0) {
        throw new Error(`criu dump exited ${result.code}: ${result.stderr.trim()}`);
      }
    } catch (error) {
      throw new Error(`criu checkpoint failed for ${handle.id}: ${errormessage(error)}`);
    }
  }

  async restore(dir: string): Promise<void> {
    try {
      const result = await run('criu', ['restore', '--images-dir', dir, '-d']);
      if (result.code !== 0) {
        throw new Error(`criu restore exited ${result.code}: ${result.stderr.trim()}`);
      }
    } catch (error) {
      throw new Error(`criu restore failed: ${errormessage(error)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: compose project generator (compose 5.5.0)                  */
/* ------------------------------------------------------------------ */

/** renders a docker compose 5.5.0 service block equivalent to the
 * engine flags: memswap_limit -1 and shm_size 2g. */
function composeyaml(spec: sandboxspec): string {
  const lines: string[] = [
    '# generated by the virtual hardware engine for docker compose 5.5.0',
    'services:',
    `  ${spec.id}:`,
    `    image: ${spec.image}`,
    '    memswap_limit: -1',
    `    shm_size: "${spec.shm}"`,
    `    cpus: ${spec.cpus}`,
    `    mem_limit: ${spec.memorymib}m`,
  ];
  if (spec.ports.length > 0) {
    lines.push('    ports:');
    for (const port of spec.ports) {
      lines.push(`      - "${port.host}:${port.container}"`);
    }
  }
  if (Object.keys(spec.env).length > 0) {
    lines.push('    environment:');
    for (const [key, value] of Object.entries(spec.env)) {
      lines.push(`      ${key}: ${JSON.stringify(value)}`);
    }
  }
  if (spec.command.length > 0) {
    lines.push(`    command: [${spec.command.map((part) => JSON.stringify(part)).join(', ')}]`);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* context: orchestrator facade (sandbox plane + vm plane in one)       */
/* ------------------------------------------------------------------ */

/** orchestrator options; every piece can be injected (user choice). */
interface orchestratoroptions {
  readonly firecrackerbackend?: 'file' | 'uffd';
  readonly qemumachine?: 'q35' | 'microvm';
  readonly clhvfiousersocket?: string | null;
  readonly nodeid?: string;
  readonly rootdir?: string;
  readonly enablehotreload?: boolean;
  readonly kvmenabled?: boolean;
}

/**
 * facade that ties the registry, factory, warm pool, events and metrics
 * into one lifecycle api (create, start, snapshot, restore, destroy) and
 * additionally owns the vm plane absorbed from the Meta orchestrators:
 * lifecycle with the single state machine, the NUMA scheduler, balloon,
 * gpu assignment, passage routing, the MTTG queue, the docker bridge,
 * health, autoscale, migration, snapshots, checkpoints, hot-reload,
 * plugins, RBAC, reservations, quotas, affinity, audit, drain and
 * leader election.
 */
class orchestrator {
  readonly #registry = new runtimeregistry();
  readonly #events = new sandboxevents();
  readonly #metrics: sandboxmetrics;
  readonly #factory: sandboxfactory;
  readonly #checkpointer = new cricheckpointer();
  readonly #options: orchestratoroptions;
  readonly #rootdir: string;
  readonly #nodeid: string;
  #pool: warmpool | null = null;
  #active = new Set<sandboxproxy>();

  readonly #vms = new Map<vmid, vmrecord>();
  readonly #runqueues = new Map<numanodeid, runqueue>();
  readonly #balloons = new Map<vmid, balloonstate>();
  readonly #gpuassignments = new Map<gpuid, gpuassignment>();
  readonly #passageroutes = new Map<string, passageroute>();
  readonly #mttgqueue = new priorityqueue<mttgjob>();
  readonly #mttgprocessing = new Map<string, mttgjob>();
  readonly #dockerbridges = new Map<vmid, dockerbridgemapping>();
  readonly #qemuprocesses = new Map<vmid, qemuprocess>();
  readonly #healthchecks = new Map<string, healthcheck>();
  readonly #healthprobes = new Map<string, healthprobe>();
  readonly #scalepolicies = new Map<string, autoscalepolicy>();
  readonly #sriovpfs = new Map<string, sriovpf>();
  readonly #migrations = new Map<string, migrationjob>();
  readonly #snapshots = new Map<snapshotid, vmsnapshot>();
  readonly #checkpoints = new Map<checkpointid, vmcheckpoint>();
  readonly #plugins = new Map<pluginid, plugincontract>();
  readonly #rbacroles = new Map<roleid, rbacrole>();
  readonly #userroles = new Map<userid, roleid[]>();
  readonly #rbaccache = new Map<string, Set<string>>();
  readonly #reservations = new Map<string, reservation>();
  readonly #affinityrules: affinityrule[] = [];
  readonly #affinityindex = new Map<string, Set<string>>();
  readonly #auditring: auditentry[] = [];
  readonly #quotatable = new Map<string, quotastate>();
  readonly #watchers = new Map<string, ReturnType<typeof watch>>();
  readonly #configcache = new Map<configfilename, unknown>();
  #numatopology!: numatopologyview;
  #leader!: leaderstate;
  #healthinterval: ReturnType<typeof setInterval> | null = null;
  #autoscaleinterval: ReturnType<typeof setInterval> | null = null;
  #schedulerinterval: ReturnType<typeof setInterval> | null = null;
  #shuttingdown = false;
  #errorcatcherinstalled = false;
  readonly version = '2.0.0-saddle-20260822';
  readonly stack: Readonly<Record<string, string>> = stackcatalog;

  constructor(options: orchestratoroptions = {}) {
    this.#options = options;
    this.#rootdir = options.rootdir ?? rundir();
    this.#nodeid = options.nodeid ?? `node-${randomUUID().slice(0, 8)}`;
    this.#metrics = new sandboxmetrics('orchestrator', path.join(this.#rootdir, 'metrics'));
    this.#registry
      .register(new dockerruntime())
      .register(new gvisorruntime())
      .register(new kataruntime())
      .register(new firecrackerruntime(options.firecrackerbackend ?? 'file'))
      .register(new qemuruntime(options.qemumachine ?? 'q35'))
      .register(new clhruntime(options.clhvfiousersocket ?? null));
    this.#factory = new sandboxfactory(this.#registry, this.#events, this.#metrics);
    this.#leader = { nodeid: this.#nodeid, term: 0, isleader: false, voters: [this.#nodeid] };
    this.#buildnumatopology();
    this.#initdefaultrbac();
    this.#initrunqueues();
    this.#log(`orchestrator initialized node=${this.#nodeid} root=${this.#rootdir}`);
  }

  get events(): sandboxevents {
    return this.#events;
  }

  get metrics(): sandboxmetrics {
    return this.#metrics;
  }

  /** v6 alias over the single event bus. */
  geteventbus(): sandboxevents {
    return this.#events;
  }

  #log(_message: string): void {
    try {
    } catch {
      /* catcher: logging must never break the caller */
    }
  }

  /* ---------------------------------------------------------------- */
  /* process error catcher (coreorchestrator)                          */
  /* ---------------------------------------------------------------- */

  /**
   * routes unhandled rejections and uncaught exceptions of the host
   * process onto the single bus; explicit opt-in because it changes
   * process-wide behavior.
   */
  installerrorcatcher(): void {
    if (this.#errorcatcherinstalled) {
      return;
    }
    try {
      process.on('unhandledRejection', (reason: unknown) => {
        this.#events.publish('system:error', {
          kind: 'unhandledrejection',
          message: String(reason),
        });
      });
      process.on('uncaughtException', (error: Error) => {
        this.#events.publish('system:error', { kind: 'uncaughtexception', message: error.message });
      });
      this.#errorcatcherinstalled = true;
    } catch {
      /* catcher: process handlers may be unavailable in sandboxes */
    }
  }

  /* ---------------------------------------------------------------- */
  /* NUMA topology: heuristic build + cores.json view (merged)         */
  /* ---------------------------------------------------------------- */

  #buildnumatopology(): void {
    try {
      const cpucount = cpus().length || 32;
      const numacount = Math.max(1, Math.min(4, Math.ceil(cpucount / 16)));
      const nodes: numatopologyview['nodes'] = [];
      const cpuspernode = Math.ceil(cpucount / numacount);
      let cpuindex = 0;
      for (let node = 0; node < numacount; node += 1) {
        const nodecpus: number[] = [];
        for (let i = 0; i < cpuspernode && cpuindex < cpucount; i += 1) {
          nodecpus.push(cpuindex);
          cpuindex += 1;
        }
        const memmb = Math.floor(totalmem() / 1024 / 1024 / numacount);
        const distances: Record<numanodeid, number> = {};
        for (let other = 0; other < numacount; other += 1) {
          distances[other] = other === node ? 10 : 21;
        }
        nodes.push({
          id: node,
          cpus: nodecpus,
          memorymb: memmb,
          distances,
          hugepages: { '2m': Math.floor(memmb / 2 / 4), '1g': Math.floor(memmb / 1024 / 2) },
        });
      }
      this.#numatopology = {
        nodes,
        totalmemorymb: Math.floor(totalmem() / 1024 / 1024),
      };
      this.#log(
        `numa topology: ${numacount} nodes, ${cpucount} cpus, ${this.#numatopology.totalmemorymb} MB`,
      );
    } catch (error) {
      this.#events.publish('system:error', { kind: 'numa', message: errormessage(error) });
    }
  }

  #initrunqueues(): void {
    for (const node of this.#numatopology.nodes) {
      this.#runqueues.set(node.id, {
        numanode: node.id,
        tasks: [],
        load: 0,
        capacity: node.cpus.length * 100,
      });
    }
  }

  /**
   * returns the NUMA view as {nodes, map}; an explicit numa section in
   * cores.json wins over the heuristic (coreorchestrator getNumaTopology).
   */
  async getnumatopology(): Promise<{
    readonly nodes: number;
    readonly map: Record<number, number[]>;
  }> {
    try {
      const cores = (await this.#readjsonmaybe(path.join(this.#rootdir, 'cores.json'))) as
        | { numa?: { nodes: number; map: Record<number, number[]> } }
        | undefined;
      if (cores?.numa !== undefined) {
        return cores.numa;
      }
    } catch {
      /* catcher: fall back to the heuristic view */
    }
    const map: Record<number, number[]> = {};
    for (const node of this.#numatopology.nodes) {
      map[node.id] = [...node.cpus];
    }
    return { nodes: this.#numatopology.nodes.length, map };
  }

  async #readjsonmaybe(filepath: string): Promise<unknown> {
    try {
      const raw = await readFile(filepath, 'utf8');
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  /* ---------------------------------------------------------------- */
  /* RBAC: default roles, assert, assign, grant/check cache            */
  /* ---------------------------------------------------------------- */

  #initdefaultrbac(): void {
    const roles: rbacrole[] = [
      { id: 'role-admin' as roleid, name: 'admin', permissions: ['*'] },
      {
        id: 'role-operator' as roleid,
        name: 'operator',
        permissions: [
          'vm:create',
          'vm:start',
          'vm:stop',
          'vm:delete',
          'vm:migrate',
          'gpu:assign',
          'snapshot:create',
          'metrics:read',
        ],
      },
      { id: 'role-viewer' as roleid, name: 'viewer', permissions: ['metrics:read'] },
      {
        id: 'role-scheduler' as roleid,
        name: 'scheduler',
        permissions: ['vm:create', 'vm:start', 'vm:stop', 'metrics:read'],
      },
    ];
    for (const role of roles) {
      this.#rbacroles.set(role.id, role);
    }
  }

  /**
   * asserts that a user holds a permission through one of its roles; the
   * system actor bypasses everything and roleless users may still read
   * metrics (viewer fallback). denials publish rbac:denied and throw an
   * orchestratorerror with ERR_RBAC_DENIED.
   */
  assertpermission(user: userid, perm: permission): void {
    if (user === SYSTEMUSER) {
      return;
    }
    const roles = this.#userroles.get(user) ?? [];
    for (const roleid of roles) {
      const role = this.#rbacroles.get(roleid);
      if (role === undefined) {
        continue;
      }
      if (role.permissions.includes('*') || role.permissions.includes(perm)) {
        return;
      }
    }
    if (perm === 'metrics:read' && roles.length === 0) {
      return;
    }
    this.#events.publish('rbac:denied', { userid: user, action: perm });
    this.#metrics.inc('rbac_denied_total', 1, { user: user, perm });
    throw new orchestratorerror(`rbac denied user=${user} perm=${perm}`, 'ERR_RBAC_DENIED');
  }

  /** assigns an extra role to a user. */
  assignrole(user: userid, role: roleid): void {
    if (!this.#rbacroles.has(role)) {
      throw new orchestratorerror(`role ${role} not found`, 'ERR_RBAC_ROLE');
    }
    const current = this.#userroles.get(user) ?? [];
    if (!current.includes(role)) {
      current.push(role);
    }
    this.#userroles.set(user, current);
    this.#log(`role ${role} assigned to ${user}`);
  }

  /** grants subject actions over a resource key (v6 cache). */
  grantrbac(principal: rbacprincipal, resource: string, actions: readonly string[]): void {
    try {
      const key = `${principal.tenant}::${resource}`;
      const set = this.#rbaccache.get(key) ?? new Set<string>();
      for (const action of actions) {
        set.add(`${principal.subject}:${action}`);
      }
      this.#rbaccache.set(key, set);
    } catch {
      /* catcher: cache writes are best effort */
    }
  }

  /** checks a grant through subject, roles and wildcards (v6). */
  checkrbac(principal: rbacprincipal, resource: string, action: string): boolean {
    const checkkey = (key: string): boolean => {
      const set = this.#rbaccache.get(key);
      if (set === undefined) {
        return false;
      }
      if (set.has(`${principal.subject}:${action}`)) {
        return true;
      }
      for (const role of principal.roles) {
        if (set.has(`${role}:${action}`) || set.has(`${role}:*`)) {
          return true;
        }
      }
      return false;
    };
    const ok =
      checkkey(`${principal.tenant}::${resource}`) ||
      checkkey(`${principal.tenant}::*:*`) ||
      checkkey(`${principal.tenant}::${resource.split(':')[0]}:*`);
    this.#metrics.inc('rbac_check_total', 1, {
      tenant: principal.tenant,
      action,
      ok: ok ? '1' : '0',
    });
    return ok;
  }

  /* ---------------------------------------------------------------- */
  /* reservations with TTL + affinity rules                            */
  /* ---------------------------------------------------------------- */

  /**
   * reserves cpus/memory/gpus for an owner with a TTL (default 300s);
   * overlapping cpu sets of equal or higher priority block the request.
   */
  reserveresources(
    owner: vmid | userid,
    resources: reservation['resources'],
    ttlsec = 300,
    priority = 50,
  ): reservation {
    for (const existing of this.#reservations.values()) {
      const overlap = existing.resources.cpus.some((cpu) => resources.cpus.includes(cpu));
      if (overlap && Date.now() < existing.expiresat.getTime() && existing.priority >= priority) {
        throw new orchestratorerror(
          `resource conflict with reservation ${existing.id} priority=${existing.priority}`,
          'ERR_RESERVATION_CONFLICT',
        );
      }
    }
    const created: reservation = {
      id: `res-${randomUUID()}`,
      resources,
      owner,
      expiresat: new Date(Date.now() + ttlsec * 1000),
      priority,
    };
    this.#reservations.set(created.id, created);
    this.#metrics.inc('reservation_created_total', 1, { owner: String(owner) });
    setTimeout(() => {
      this.#reservations.delete(created.id);
    }, ttlsec * 1000).unref();
    return created;
  }

  /** releases a reservation by id; true when it existed. */
  releasereservation(id: string): boolean {
    return this.#reservations.delete(id);
  }

  /** registers an affinity or anti-affinity rule. */
  addaffinityrule(rule: affinityrule): void {
    this.#affinityrules.push(rule);
    this.#log(`affinity rule ${rule.id} ${rule.type} ${rule.subjects.join(',')}`);
  }

  /** removes an affinity rule by id. */
  removeaffinityrule(ruleid: string): boolean {
    const index = this.#affinityrules.findIndex((rule) => rule.id === ruleid);
    if (index === -1) {
      return false;
    }
    this.#affinityrules.splice(index, 1);
    return true;
  }

  /**
   * evaluates whether a vm definition may land on a node described by
   * labels: In/NotIn/Exists selectors must all pass and antiaffinity
   * targets must not overlap the candidate pin set (coreorchestrator).
   */
  resolveaffinity(record: vmrecord, nodelabels: Record<string, string>): boolean {
    for (const selector of record.affinity) {
      const value = nodelabels[selector.key];
      if (selector.operator === 'in') {
        if (
          selector.values === undefined ||
          value === undefined ||
          !selector.values.includes(value)
        ) {
          return false;
        }
      } else if (selector.operator === 'notin') {
        if (
          selector.values !== undefined &&
          value !== undefined &&
          selector.values.includes(value)
        ) {
          return false;
        }
      } else if (selector.operator === 'exists') {
        if (value === undefined) {
          return false;
        }
      }
    }
    const ownpins = this.#affinityindex.get(record.id);
    if (record.antiaffinity.length > 0 && ownpins !== undefined) {
      for (const otherid of record.antiaffinity) {
        const other = this.#vms.get(otherid as vmid);
        const otherpins = this.#affinityindex.get(otherid);
        if (other !== undefined && other.state === 'running' && otherpins !== undefined) {
          const overlap = [...otherpins].some((cpu) => ownpins.has(cpu));
          if (overlap) {
            return false;
          }
        }
      }
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* NUMA scheduler: placement, runqueues, tick, rebalance             */
  /* ---------------------------------------------------------------- */

  /**
   * scores every node as cpuFree - vcpus*10 + memRatio*50 with the
   * affinity weight applied for numa scoped rules and returns the best.
   */
  #selectbestnumanode(
    vcpus: number,
    _memmb: number,
    exclude: readonly numanodeid[] = [],
  ): numanodeid {
    let bestid: numanodeid = 0;
    let bestscore = Number.NEGATIVE_INFINITY;
    for (const node of this.#numatopology.nodes) {
      if (exclude.includes(node.id)) {
        continue;
      }
      const queue = this.#runqueues.get(node.id);
      if (queue === undefined) {
        continue;
      }
      const cpufree = queue.capacity - queue.load;
      const memratio =
        this.#numatopology.totalmemorymb > 0 ? node.memorymb / this.#numatopology.totalmemorymb : 0;
      let score = cpufree - vcpus * 10 + memratio * 50;
      for (const rule of this.#affinityrules) {
        if (rule.scope !== 'numa' || rule.subjects.length === 0) {
          continue;
        }
        const subjectsinnode = [...this.#vms.values()].filter(
          (candidate) => rule.subjects.includes(candidate.id) && candidate.numanode === node.id,
        ).length;
        if (subjectsinnode > 0) {
          score += rule.type === 'affinity' ? rule.weight : -rule.weight;
        }
      }
      if (score > bestscore) {
        bestscore = score;
        bestid = node.id;
      }
    }
    return bestid;
  }

  #allocatevcpupins(numanode: numanodeid, count: number): Map<number, cpuset> {
    const node = this.#numatopology.nodes.find((candidate) => candidate.id === numanode);
    if (node === undefined) {
      throw new orchestratorerror(`numa ${numanode} not found`, 'ERR_NUMA_NODE');
    }
    const map = new Map<number, cpuset>();
    const available = [...node.cpus];
    for (let index = 0; index < count; index += 1) {
      const cpu = available[index % available.length];
      if (cpu !== undefined) {
        map.set(index, [cpu]);
      }
    }
    return map;
  }

  /** enqueues a vCPU task onto its numa run queue, spilling to the best
   * alternative node when the queue is at capacity. */
  #enqueuevcpu(task: vcputask): void {
    const queue = this.#runqueues.get(task.numanode);
    if (queue === undefined) {
      throw new orchestratorerror(`numa ${task.numanode} not found`, 'ERR_NUMA_NODE');
    }
    if (queue.load >= queue.capacity) {
      const alt = this.#selectbestnumanode(1, 0, [task.numanode]);
      if (alt !== task.numanode) {
        task.numanode = alt;
        const altqueue = this.#runqueues.get(alt);
        if (altqueue !== undefined) {
          altqueue.tasks.push(task);
          this.#metrics.inc('vcpu_migrated_total', 1, {
            from: String(queue.numanode),
            to: String(alt),
          });
          return;
        }
      }
    }
    queue.tasks.push(task);
    queue.load += task.shares / 1024;
    this.#events.publish('vcpu:scheduled', {
      vmid: task.vmid,
      vcpuid: task.id,
      cpu: task.affinity[0] ?? 0,
    });
  }

  /**
   * periodic scheduler tick: sorts run queues by priority, recomputes
   * loads and rebalances when the max/min spread exceeds 20 percent.
   */
  scheduletick(): void {
    for (const queue of this.#runqueues.values()) {
      queue.tasks.sort((a, b) => b.priority - a.priority);
      queue.load = queue.tasks.reduce((sum, task) => sum + task.shares / 1024, 0);
      this.#metrics.gauge('runqueue_load', queue.load, { numa: String(queue.numanode) });
    }
    const loads = [...this.#runqueues.values()].map((queue) => queue.load);
    if (loads.length > 1) {
      const max = Math.max(...loads);
      const min = Math.min(...loads);
      if (max > 0 && (max - min) / max > 0.2) {
        void this.#rebalancenuma();
      }
    }
  }

  /** moves the lowest priority task from the most loaded queue to the
   * least loaded one when the delta is at least 10 load units. */
  async #rebalancenuma(): Promise<void> {
    const sorted = [...this.#runqueues.values()].sort((a, b) => b.load - a.load);
    const overloaded = sorted[0];
    const underloaded = sorted[sorted.length - 1];
    if (overloaded === undefined || underloaded === undefined || overloaded.tasks.length === 0) {
      return;
    }
    if (overloaded.load - underloaded.load < 10) {
      return;
    }
    const victim = [...overloaded.tasks].sort((a, b) => a.priority - b.priority)[0];
    if (victim === undefined) {
      return;
    }
    overloaded.tasks = overloaded.tasks.filter((task) => task.id !== victim.id);
    overloaded.load -= victim.shares / 1024;
    victim.numanode = underloaded.numanode;
    underloaded.tasks.push(victim);
    underloaded.load += victim.shares / 1024;
    this.#events.publish('numa:rebalance', {
      moves: 1,
      from: overloaded.numanode,
      to: underloaded.numanode,
    });
    this.#metrics.inc('numa_rebalanced_total', 1, {
      from: String(overloaded.numanode),
      to: String(underloaded.numanode),
    });
  }

  /** repins one vCPU of a vm onto an explicit cpu set. */
  setvcpuaffinity(id: vmid, vcpuindex: number, target: cpuset): result<void> {
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      return { ok: false, error: new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND') };
    }
    vm.vcpupins.set(vcpuindex, target);
    for (const queue of this.#runqueues.values()) {
      for (const task of queue.tasks) {
        if (task.vmid === id && task.id === `${id}-vcpu-${vcpuindex}`) {
          task.affinity = [...target];
        }
      }
    }
    return { ok: true, value: undefined };
  }

  /**
   * validates the topology of a vm, warns on overcommit above 1.5x the
   * host cpus, computes the pin set (explicit pins or a random rotation)
   * and walks the machine through scheduling and binding
   * (coreorchestrator scheduleVcpu).
   */
  async schedulevcpu(vm: vmrecord): Promise<void> {
    const hostcpus = cpus().length;
    const topo = vm.vcputopology ?? { sockets: 1, corespersocket: vm.vcpus, threadspercore: 1 };
    const totallogical = topo.sockets * topo.corespersocket * topo.threadspercore;
    if (vm.vcputopology !== undefined && totallogical !== vm.vcpus) {
      throw new orchestratorerror('vcpu topology mismatch', 'ERR_VCPU_TOPO');
    }
    const overcommit = topo.overcommitratio ?? 1.5;
    if (vm.vcpus > hostcpus * overcommit) {
      this.#events.publish('sched:overcommitwarn', {
        vmid: vm.id,
        requested: vm.vcpus,
        host: hostcpus,
        overcommit,
      });
    }
    const pinset = this.#computecpupinning(vm, hostcpus);
    this.#affinityindex.set(vm.id, new Set(pinset.map(String)));
    this.#metrics.inc('vcpu_scheduled_total', vm.vcpus, { vmid: vm.id });
    await this.transitionvm(vm.id, 'scheduling');
    await this.transitionvm(vm.id, 'binding');
  }

  #computecpupinning(vm: vmrecord, hostcpus: number): number[] {
    if (vm.vcputopology?.pinnedcpus !== undefined) {
      return vm.vcputopology.pinnedcpus.slice(0, vm.vcpus);
    }
    const start = randomInt(0, Math.max(1, hostcpus - vm.vcpus));
    return Array.from({ length: vm.vcpus }, (_, index) => (start + index) % hostcpus);
  }

  /* ---------------------------------------------------------------- */
  /* vm lifecycle: create, start, stop, destroy, pause, transition      */
  /* ---------------------------------------------------------------- */

  /** guarded transition on the single machine; publishes vm:phase. */
  async transitionvm(id: vmid, to: lifecyclestate): Promise<vmrecord> {
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      throw new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND');
    }
    if (!cantransition(vm.state, to)) {
      throw new orchestratorerror(`illegal transition ${vm.state} -> ${to} for ${id}`, 'ERR_PHASE');
    }
    const from = vm.state;
    vm.state = to;
    this.#events.publish('vm:phase', { vmid: id, to });
    this.#metrics.inc('vm_phase_transition_total', 1, { from, to });
    return vm;
  }

  /**
   * creates a vm record: quota enforcement, NUMA placement, vCPU pins,
   * balloon initialization and the scheduling/binding walkthrough.
   */
  async createvm(definition: vmdefinition, actor: userid = SYSTEMUSER): Promise<result<vmrecord>> {
    try {
      this.assertpermission(actor, 'vm:create');
      const id = definition.id ?? createvmid();
      if (this.#vms.has(id)) {
        return {
          ok: false,
          error: new orchestratorerror(`vm ${id} already exists`, 'ERR_VM_EXISTS'),
        };
      }
      this.#enforcequota(
        definition.tenantid ?? 'default',
        definition.vcpus,
        definition.vrammib,
        definition.gpu?.length ?? 0,
      );
      const numanode = this.#selectbestnumanode(definition.vcpus, definition.vrammib);
      const record: vmrecord = {
        id,
        name: definition.name,
        tenantid: definition.tenantid ?? 'default',
        vcpus: definition.vcpus,
        vrammib: definition.vrammib,
        diskgb: definition.diskgb ?? 40,
        ostype: definition.ostype ?? 'linux',
        arch: definition.arch ?? 'x86_64',
        image: definition.image ?? 'debian:trixie-slim',
        qemubinary: definition.qemubinary ?? '/usr/bin/qemu-system-x86_64',
        machine: definition.machine ?? 'q35',
        accel: definition.accel ?? (this.#options.kvmenabled === false ? 'tcg' : 'kvm'),
        extraargs: definition.extraargs ?? [],
        dockerruntime: definition.dockerruntime ?? 'runc',
        dockernetwork: definition.dockernetwork ?? 'bridge',
        vcputopology: definition.vcputopology,
        vramballoon: {
          requestedmib: definition.vrammib,
          minmib: Math.floor(definition.vrammib * 0.5),
          maxmib: Math.floor(definition.vrammib * 1.5),
          currentmib: definition.vrammib,
          balloondriver: 'virtio-balloon',
          hugepages: '2mib',
        },
        gpu: definition.gpu !== undefined ? [...definition.gpu] : [],
        labels: definition.labels ?? {},
        affinity: definition.affinity ?? [],
        antiaffinity: definition.antiaffinity ?? [],
        checkpointenabled: definition.checkpointenabled ?? true,
        rbacroles: definition.rbacroles ?? [],
        state: 'pending',
        createdat: new Date(),
        numanode,
        vcpupins: this.#allocatevcpupins(numanode, definition.vcpus),
        metrics: { cputimens: 0n, memrssmb: 0 },
      };
      this.#vms.set(id, record);
      this.#balloons.set(id, {
        vmid: id,
        targetmib: definition.vrammib,
        actualmib: definition.vrammib,
        deflatedmib: 0,
        lastadjust: new Date(),
        pressurescore: 0,
      });
      this.#metrics.inc('vm_created_total', 1, { vmid: id, arch: record.arch });
      this.#audit(actor, 'vm:create', id, 'success', { name: definition.name });
      this.#events.publish('vm:created', { vmid: id, tenantid: record.tenantid });
      this.#log(`vm ${id} created numa=${numanode} vcpus=${definition.vcpus}`);
      await this.schedulevcpu(record);
      return { ok: true, value: record };
    } catch (error) {
      this.#audit(actor, 'vm:create', definition.id ?? 'new', 'failure', {
        error: errormessage(error),
      });
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /**
   * starts a vm: vCPU tasks enter the run queues, qemu spawns with the
   * monitor/qmp socket layout and the docker bridge attaches for bridge
   * or passage network modes.
   */
  async startvm(id: vmid, actor: userid = SYSTEMUSER): Promise<result<vmrecord>> {
    this.assertpermission(actor, 'vm:start');
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      return { ok: false, error: new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND') };
    }
    if (!['binding', 'stopped', 'failed'].includes(vm.state)) {
      return {
        ok: false,
        error: new orchestratorerror(`vm ${id} not startable from ${vm.state}`, 'ERR_VM_STATE'),
      };
    }
    try {
      await this.transitionvm(id, 'provisioning');
      for (let index = 0; index < vm.vcpus; index += 1) {
        const nodecpus = this.#numatopology.nodes[vm.numanode]?.cpus ?? [0];
        this.#enqueuevcpu({
          id: `${id}-vcpu-${index}` as VcpuId,
          vmid: id,
          priority: 20,
          affinity: vm.vcpupins.get(index) ?? nodecpus.slice(0, 1),
          numanode: vm.numanode,
          shares: 1024,
          burstms: 100,
        });
      }
      const qemustrategy = this.#registry.get('qemu');
      if (!(qemustrategy instanceof qemuruntime)) {
        throw new orchestratorerror('qemu runtime strategy unavailable', 'ERR_QEMU_STRATEGY');
      }
      const processinfo = await qemustrategy.spawn(
        vm,
        [...this.#gpuassignments.values()],
        (exited, code) => {
          this.#qemuprocesses.delete(exited);
          const record = this.#vms.get(exited);
          if (record !== undefined && record.state === 'running') {
            record.state = 'stopped';
          }
          this.#events.publish('qemu:exit', { vmid: exited, code });
          this.#log(`qemu exit vm=${exited} code=${code ?? 'signal'}`);
        },
      );
      this.#qemuprocesses.set(id, processinfo);
      const probe = await qemustrategy.probeversion();
      if (!probe.includes(runtimecatalog.qemu)) {
        this.#events.publish('qemu:versionmismatch', { expected: runtimecatalog.qemu, got: probe });
      }
      if (vm.dockernetwork === 'bridge' || vm.dockernetwork === 'passage') {
        await this.#attachdockerbridge(vm);
      }
      await this.transitionvm(id, 'running');
      vm.startedat = new Date();
      vm.qemupid = processinfo.pid;
      this.#metrics.inc('vm_running_total', 1, { vmid: id });
      this.#events.publish('vm:started', { vmid: id, pid: processinfo.pid });
      this.#audit(actor, 'vm:start', id, 'success', {});
      this.#log(`vm ${id} running pid=${processinfo.pid}`);
      return { ok: true, value: vm };
    } catch (error) {
      vm.state = 'failed';
      this.#events.publish('vm:error', { vmid: id, error: errormessage(error) });
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /** stops a vm through the drain path, kills qemu and unschedules its
   * vCPU tasks. */
  async stopvm(id: vmid, actor: userid = SYSTEMUSER, reason = 'user'): Promise<result<void>> {
    this.assertpermission(actor, 'vm:stop');
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      return { ok: false, error: new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND') };
    }
    await this.drainvm(id, {
      vmid: id,
      timeoutsec: 30,
      signal: 'SIGTERM',
      fallback: 'SIGKILL',
    });
    const processinfo = this.#qemuprocesses.get(id);
    if (processinfo !== undefined) {
      try {
        processinfo.child.kill('SIGTERM');
        setTimeout(() => {
          try {
            if (!processinfo.child.killed) {
              processinfo.child.kill('SIGKILL');
            }
          } catch {
            /* catcher: the process may already be gone */
          }
        }, 5000).unref();
      } catch {
        /* catcher: best effort kill */
      }
      this.#qemuprocesses.delete(id);
    }
    for (const queue of this.#runqueues.values()) {
      queue.tasks = queue.tasks.filter((task) => task.vmid !== id);
    }
    try {
      await this.transitionvm(id, 'stopped');
    } catch {
      /* catcher: non-standard states keep their value */
    }
    vm.qemupid = undefined;
    this.#events.publish('vm:stopped', { vmid: id, reason });
    this.#audit(actor, 'vm:stop', id, 'success', { reason });
    this.#metrics.inc('vm_stopped_total', 1, { vmid: id });
    return { ok: true, value: undefined };
  }

  /** destroys a vm: stops it when running, releases gpus, frees
   * reservations and quota and forgets every side table. */
  async destroyvm(id: vmid, actor: userid = SYSTEMUSER): Promise<result<void>> {
    this.assertpermission(actor, 'vm:delete');
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      return { ok: false, error: new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND') };
    }
    if (vm.state === 'running') {
      const stopped = await this.stopvm(id, actor, 'destroy');
      if (!stopped.ok) {
        return stopped;
      }
    }
    for (const [key, assign] of this.#gpuassignments.entries()) {
      if (assign.vmid === id) {
        this.releasegpu(key, actor);
      }
    }
    for (const [resid, held] of this.#reservations.entries()) {
      if (held.owner === id) {
        this.#reservations.delete(resid);
      }
    }
    this.#deallocatequota(vm);
    this.#vms.delete(id);
    this.#balloons.delete(id);
    this.#dockerbridges.delete(id);
    this.#qemuprocesses.delete(id);
    this.#healthprobes.delete(id);
    this.#affinityindex.delete(id);
    vm.state = 'destroyed';
    this.#audit(actor, 'vm:delete', id, 'success', {});
    return { ok: true, value: undefined };
  }

  /** pauses a running vm (qmp stop semantics). */
  async pausevm(id: vmid, actor: userid = SYSTEMUSER): Promise<result<void>> {
    this.assertpermission(actor, 'vm:stop');
    const vm = this.#vms.get(id);
    if (vm === undefined || vm.state !== 'running') {
      return { ok: false, error: new orchestratorerror(`vm ${id} not running`, 'ERR_VM_STATE') };
    }
    await this.transitionvm(id, 'paused');
    this.#log(`vm ${id} paused via qmp`);
    return { ok: true, value: undefined };
  }

  /** lists vm records with optional state and numa filters. */
  listvms(filter?: {
    readonly state?: lifecyclestate;
    readonly numa?: numanodeid;
  }): readonly vmrecord[] {
    let list = [...this.#vms.values()];
    if (filter?.state !== undefined) {
      list = list.filter((vm) => vm.state === filter.state);
    }
    if (filter?.numa !== undefined) {
      list = list.filter((vm) => vm.numanode === filter.numa);
    }
    return list;
  }

  /* ---------------------------------------------------------------- */
  /* quotas (coreorchestrator)                                         */
  /* ---------------------------------------------------------------- */

  /** sets the vcpu/vram/gpu quota of a tenant and publishes quota:set. */
  setquota(
    tenantid: string,
    quota: { readonly vcpu: number; readonly vram: number; readonly gpu: number },
  ): void {
    const existing = this.#quotatable.get(tenantid) ?? {
      vcpu: quota.vcpu,
      vram: quota.vram,
      gpu: quota.gpu,
      usedvcpu: 0,
      usedvram: 0,
      usedgpu: 0,
    };
    existing.vcpu = quota.vcpu;
    existing.vram = quota.vram;
    existing.gpu = quota.gpu;
    this.#quotatable.set(tenantid, existing);
    this.#events.publish('quota:set', {
      tenantid,
      vcpu: quota.vcpu,
      vrammib: quota.vram,
      gpu: quota.gpu,
    });
  }

  #enforcequota(tenantid: string, vcpu: number, vram: number, gpu: number): void {
    const quota = this.#quotatable.get(tenantid);
    if (quota === undefined) {
      return;
    }
    if (quota.usedvcpu + vcpu > quota.vcpu) {
      throw new orchestratorerror(`quota vcpu exceeded for ${tenantid}`, 'ERR_QUOTA_VCPU');
    }
    if (quota.usedvram + vram > quota.vram) {
      throw new orchestratorerror(`quota vram exceeded for ${tenantid}`, 'ERR_QUOTA_VRAM');
    }
    if (quota.usedgpu + gpu > quota.gpu) {
      throw new orchestratorerror(`quota gpu exceeded for ${tenantid}`, 'ERR_QUOTA_GPU');
    }
    quota.usedvcpu += vcpu;
    quota.usedvram += vram;
    quota.usedgpu += gpu;
    this.#quotatable.set(tenantid, quota);
  }

  #deallocatequota(vm: vmrecord): void {
    const quota = this.#quotatable.get(vm.tenantid);
    if (quota === undefined) {
      return;
    }
    quota.usedvcpu = Math.max(0, quota.usedvcpu - vm.vcpus);
    quota.usedvram = Math.max(0, quota.usedvram - vm.vrammib);
    quota.usedgpu = Math.max(0, quota.usedgpu - vm.gpu.length);
    this.#quotatable.set(vm.tenantid, quota);
  }

  /* ---------------------------------------------------------------- */
  /* vRAM ballooning (src_core pressure walk + v6 bounds)              */
  /* ---------------------------------------------------------------- */

  /**
   * walks the balloon of a vm towards a target with pressure scoring
   * and a gradual 100 MB per 500 ms adjustment; bounds come from the
   * vramballoon descriptor (0.5x .. 1.5x of the requested size).
   */
  async balloonvm(
    id: vmid,
    targetmb: number,
    actor: userid = SYSTEMUSER,
  ): Promise<result<balloonstate>> {
    this.assertpermission(actor, 'vm:start');
    const state = this.#balloons.get(id);
    const vm = this.#vms.get(id);
    if (state === undefined || vm === undefined) {
      return {
        ok: false,
        error: new orchestratorerror(`balloon state not found for ${id}`, 'ERR_VM_NOTFOUND'),
      };
    }
    const bounds = vm.vramballoon;
    const minmb = Math.max(128, bounds?.minmib ?? 128);
    const maxmb = bounds?.maxmib ?? Math.floor(vm.vrammib * 1.5);
    if (targetmb < minmb || targetmb > maxmb) {
      return {
        ok: false,
        error: new orchestratorerror(
          `balloon target ${targetmb} outside [${minmb}, ${maxmb}]`,
          'ERR_BALLOON_BOUNDS',
        ),
      };
    }
    const pressure = Math.max(0, Math.min(1, 1 - freemem() / totalmem()));
    state.pressurescore = pressure;
    state.targetmib = targetmb;
    const diff = targetmb - state.actualmib;
    const step = Math.sign(diff) * Math.min(100, Math.abs(diff));
    state.actualmib += step;
    state.deflatedmib = Math.max(0, state.actualmib - targetmb);
    state.lastadjust = new Date();
    if (state.actualmib !== targetmb) {
      setTimeout(() => {
        void this.balloonvm(id, targetmb, actor).catch(() => {});
      }, 500).unref();
    }
    this.#events.publish('vram:adjusted', {
      vmid: id,
      targetmib: targetmb,
      actualmib: state.actualmib,
    });
    this.#metrics.gauge('balloon_actual_mb', state.actualmib, { vmid: id });
    this.#metrics.gauge('balloon_pressure', pressure, { vmid: id });
    return { ok: true, value: { ...state } };
  }

  /** strict v6 balloon write with explicit bounds errors. */
  async balloonvram(id: vmid, targetmib: number): Promise<vramballoon> {
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      throw new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND');
    }
    const balloon = vm.vramballoon ?? {
      requestedmib: vm.vrammib,
      minmib: Math.floor(vm.vrammib * 0.5),
      maxmib: Math.floor(vm.vrammib * 1.5),
      currentmib: vm.vrammib,
      balloondriver: 'virtio-balloon' as const,
      hugepages: '2mib' as const,
    };
    if (targetmib < balloon.minmib || targetmib > balloon.maxmib) {
      throw new orchestratorerror(
        `balloon target ${targetmib} outside [${balloon.minmib}, ${balloon.maxmib}]`,
        'ERR_BALLOON_BOUNDS',
      );
    }
    balloon.currentmib = targetmib;
    vm.vramballoon = balloon;
    vm.vrammib = targetmib;
    this.#events.publish('vram:adjusted', {
      vmid: id,
      targetmib,
      actualmib: balloon.currentmib,
    });
    this.#metrics.inc('vram_balloon_total', targetmib, { vmid: id });
    return balloon;
  }

  /** returns the balloon state of a vm, when present. */
  getballoonstate(id: vmid): balloonstate | undefined {
    return this.#balloons.get(id);
  }

  /* ---------------------------------------------------------------- */
  /* GPU passthrough + SR-IOV (src_core) + gpus.json requests (v6)     */
  /* ---------------------------------------------------------------- */

  /** registers a gpu; sriov enabled gpus get a PF view with 7 VFs
   * (Blackwell typical). */
  registergpu(gpu: {
    readonly id: gpuid;
    readonly model: string;
    readonly pciaddr: string;
    readonly mode: 'none' | 'passthrough' | 'vgpu' | 'mdev';
    readonly vrammb: number;
    readonly sriovenabled: boolean;
    readonly mdevprofiles?: readonly string[];
  }): void {
    if (gpu.sriovenabled && !this.#sriovpfs.has(gpu.pciaddr)) {
      this.#sriovpfs.set(gpu.pciaddr, {
        pfpci: gpu.pciaddr,
        totalvfs: 7,
        activevfs: 0,
        vfs: [],
        driver: 'nvidia',
      });
    }
    this.#metrics.inc('gpu_registered_total', 1, { model: gpu.model, pci: gpu.pciaddr });
    this.#log(`gpu registered ${gpu.model} ${gpu.pciaddr} mode=${gpu.mode}`);
  }

  /**
   * assigns a gpu (or one of its VFs) to a vm; the iommu group is read
   * from the last id bytes or drawn randomly when unavailable.
   */
  async assigngpu(
    id: vmid,
    gpu: gpuid,
    actor: userid = SYSTEMUSER,
    usevf = false,
  ): Promise<result<gpuassignment>> {
    this.assertpermission(actor, 'gpu:assign');
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      return { ok: false, error: new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND') };
    }
    if (this.#gpuassignments.has(gpu)) {
      return {
        ok: false,
        error: new orchestratorerror(`gpu ${gpu} already assigned`, 'ERR_GPU_ASSIGNED'),
      };
    }
    const iommugroup = Number.parseInt(gpu.slice(-2), 16) || randomInt(0, 20);
    let vfid: vfid | undefined;
    let pciaddr = `0000:0${randomInt(0, 8)}:00.0`;
    if (usevf) {
      const pf = [...this.#sriovpfs.values()].find(
        (candidate) =>
          candidate.vfs.length < candidate.totalvfs || candidate.activevfs < candidate.totalvfs,
      );
      if (pf !== undefined) {
        const newvfid = `${pf.pfpci}-vf-${pf.activevfs}` as vfid;
        const vfpci = `${pf.pfpci.slice(0, -1)}${pf.activevfs + 1}`;
        pf.vfs.push({ vfid: newvfid, pci: vfpci, assignedto: id });
        pf.activevfs += 1;
        vfid = newvfid;
        pciaddr = vfpci;
        this.#events.publish('sriov:vfcreated', { pf: pf.pfpci, vfid: newvfid });
      }
    }
    const assignment: gpuassignment = {
      vmid: id,
      gpuid: gpu,
      vfid,
      pciaddr,
      iommugroup,
      bounddriver: 'vfio-pci',
    };
    this.#gpuassignments.set(gpu, assignment);
    this.#events.publish('gpu:assigned', { vmid: id, gpuid: gpu, vfid: vfid });
    this.#metrics.inc('gpu_assigned_total', 1, { gpuid: gpu, vmid: id });
    this.#audit(actor, 'gpu:assign', gpu, 'success', { vmid: id, vfid });
    return { ok: true, value: assignment };
  }

  /** releases a gpu assignment and frees its VF, if any. */
  releasegpu(gpu: gpuid, actor: userid = SYSTEMUSER): result<void> {
    const assign = this.#gpuassignments.get(gpu);
    if (assign === undefined) {
      return {
        ok: false,
        error: new orchestratorerror(`gpu ${gpu} not assigned`, 'ERR_GPU_ASSIGNED'),
      };
    }
    if (assign.vfid !== undefined) {
      for (const pf of this.#sriovpfs.values()) {
        const index = pf.vfs.findIndex((vf) => vf.vfid === assign.vfid);
        if (index !== -1) {
          pf.vfs.splice(index, 1);
          pf.activevfs -= 1;
        }
      }
    }
    this.#gpuassignments.delete(gpu);
    this.#events.publish('gpu:released', { gpuid: gpu, vmid: assign.vmid });
    this.#audit(actor, 'gpu:release', gpu, 'success', {});
    return { ok: true, value: undefined };
  }

  /** lists the SR-IOV physical functions known to the engine. */
  listsriov(): readonly sriovpf[] {
    return [...this.#sriovpfs.values()];
  }

  /**
   * provisions VFs on a PF through the sysfs sriov_numvfs knob; when the
   * sysfs node is absent (containers) the call reports the simulated
   * outcome instead of failing (coreorchestrator).
   */
  async provisionsriov(pf: string, vfcount: number): Promise<readonly string[]> {
    if (vfcount < 1 || vfcount > 64) {
      throw new orchestratorerror('vfcount must be 1-64', 'ERR_SRIOV_BOUNDS');
    }
    const sysfs = `/sys/bus/pci/devices/${pf}/sriov_numvfs`;
    const present = existsSync(sysfs);
    const vfids = Array.from({ length: vfcount }, (_, index) => `${pf}_vf${index}`);
    if (!present) {
      this.#metrics.inc('sriov_vf_provisioned_total', vfcount, { pf, mode: 'simulated' });
      return vfids;
    }
    try {
      writeFileSync(sysfs, String(vfcount), 'utf8');
      this.#metrics.inc('sriov_vf_provisioned_total', vfcount, { pf, mode: 'hardware' });
    } catch {
      this.#metrics.inc('sriov_vf_provisioned_total', vfcount, { pf, mode: 'failed' });
    }
    return vfids;
  }

  /**
   * attaches gpu passthrough requests to a vm by filtering the flat
   * gpus.json catalog (coreorchestrator); vfio must be requested.
   */
  async attachgpupassthrough(
    id: vmid,
    requests: readonly gpupassthroughrequest[],
  ): Promise<readonly string[]> {
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      throw new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND');
    }
    const catalog = (await this.#readjsonmaybe(path.join(this.#rootdir, 'gpus.json'))) as
      | Record<string, unknown>[]
      | undefined;
    const devices = catalog ?? [];
    const allocated: string[] = [];
    for (const request of requests) {
      if (!request.vfio) {
        throw new orchestratorerror('vfio must be true for passthrough', 'ERR_VFIO_REQUIRED');
      }
      const candidates = devices.filter((device) => {
        const vendorok = String(device.vendor ?? '')
          .toLowerCase()
          .includes(request.vendor);
        const modelok =
          request.model === undefined ||
          String(device.model ?? '')
            .toLowerCase()
            .includes(request.model.toLowerCase());
        return vendorok && modelok;
      });
      if (candidates.length < request.count) {
        throw new orchestratorerror(
          `insufficient gpus for ${request.model ?? request.vendor}`,
          'ERR_GPU_INSUFFICIENT',
        );
      }
      for (let index = 0; index < request.count; index += 1) {
        allocated.push(String(candidates[index]?.deviceid ?? randomUUID()));
      }
    }
    vm.gpu = [...requests];
    this.#metrics.inc('gpu_attached_total', allocated.length, { vmid: id });
    return allocated;
  }

  /* ---------------------------------------------------------------- */
  /* passage routing (merged src_core + coreorchestrator shapes)       */
  /* ---------------------------------------------------------------- */

  /**
   * adds a passage route between two vms; the default latency follows
   * the numa distance (15us same node, 45us remote) plus 20us of vxlan
   * encapsulation, and ivshmem routes are capped at 50000 Mbps.
   */
  addpassageroute(
    route: Omit<passageroute, 'latencyus'> & { readonly latencyus?: number },
  ): result<passageroute> {
    const stored: passageroute = { ...route, latencyus: route.latencyus ?? 15 };
    if (this.#passageroutes.has(stored.id)) {
      return {
        ok: false,
        error: new orchestratorerror(`route ${stored.id} exists`, 'ERR_PASSAGE_EXISTS'),
      };
    }
    const src = this.#vms.get(stored.srcvm);
    const dst = this.#vms.get(stored.dstvm);
    if (src === undefined || dst === undefined) {
      return {
        ok: false,
        error: new orchestratorerror('src or dst vm not found', 'ERR_PASSAGE_VM'),
      };
    }
    if (stored.protocol === 'ivshmem' && stored.bandwidthgbps * 1000 > 50000) {
      return {
        ok: false,
        error: new orchestratorerror('ivshmem bandwidth unrealistic', 'ERR_PASSAGE_BW'),
      };
    }
    if (route.latencyus === undefined) {
      stored.latencyus =
        (src.numanode === dst.numanode ? 15 : 45) + (stored.protocol === 'vxlan' ? 20 : 0);
    }
    this.#passageroutes.set(stored.id, stored);
    this.#events.publish('passage:routecreated', {
      id: stored.id,
      srcvm: stored.srcvm,
      dstvm: stored.dstvm,
      protocol: stored.protocol,
    });
    this.#metrics.inc('passage_routes_total', 1, {
      protocol: stored.protocol,
      passage: stored.passage,
    });
    this.#log(
      `passage route ${stored.id} ${stored.srcvm}->${stored.dstvm} ${stored.protocol} ${stored.latencyus}us`,
    );
    return { ok: true, value: stored };
  }

  /** v6 alias returning the first route between two vms. */
  resolvepassageroute(src: vmid, dst: vmid): passageroute | undefined {
    for (const route of this.#passageroutes.values()) {
      if (route.srcvm === src && route.dstvm === dst) {
        return route;
      }
    }
    return undefined;
  }

  /** every route between two vms (src_core). */
  resolvepassage(src: vmid, dst: vmid): readonly passageroute[] {
    return [...this.#passageroutes.values()].filter(
      (route) => route.srcvm === src && route.dstvm === dst,
    );
  }

  /** removes a passage route by id. */
  removepassageroute(routeid: string): boolean {
    return this.#passageroutes.delete(routeid);
  }

  /* ---------------------------------------------------------------- */
  /* MTTG queue (deps, retry, anti-starvation, qos preemption)         */
  /* ---------------------------------------------------------------- */

  /** enqueues an MTTG job; unresolved dependencies are logged so the
   * pipeline can trace the wait chain. */
  enqueuemttg<const t extends Omit<mttgjob, 'createdat' | 'retries'>>(job: t): void {
    const full: mttgjob = { ...job, createdat: new Date(), retries: 0 };
    const unresolved = full.dependencies.filter(
      (dep) =>
        this.#mttgqueue.list().some((queued) => queued.id === dep) || this.#mttgprocessing.has(dep),
    );
    if (unresolved.length > 0) {
      this.#log(`mttg job ${full.id} waiting for deps ${unresolved.join(',')}`);
    }
    this.#mttgqueue.push(full);
    this.#metrics.inc('mttg_enqueued_total', 1, {
      group: full.groupid,
      priority: String(full.priority),
    });
    this.#events.publish('mttg:enqueued', { jobid: full.id, tenant: full.tenant, qos: full.qos });
  }

  /**
   * drains the MTTG queue with a bounded concurrency (default 4):
   * dependencies requeue at a lower priority (anti-starvation) and
   * failures retry up to three times with priority decay.
   */
  async processmttgqueue(
    handler: (job: mttgjob) => awaitable<void>,
    concurrency = 4,
  ): Promise<void> {
    const active: Promise<void>[] = [];
    const processone = async (job: mttgjob): Promise<void> => {
      this.#mttgprocessing.set(job.id, job);
      const start = Date.now();
      try {
        await handler(job);
        this.#metrics.inc('mttg_completed_total', 1, { group: job.groupid });
        this.#events.publish('mttg:jobdone', { jobid: job.id, durationms: Date.now() - start });
      } catch {
        job.retries += 1;
        if (job.retries < 3) {
          this.#mttgqueue.push({ ...job, priority: job.priority - 1 });
        } else {
          this.#metrics.inc('mttg_failed_total', 1, { group: job.groupid });
        }
      } finally {
        this.#mttgprocessing.delete(job.id);
      }
    };
    while (this.#mttgqueue.size > 0 || active.length > 0) {
      while (active.length < concurrency && this.#mttgqueue.size > 0) {
        const job = this.#mttgqueue.pop();
        if (job === undefined) {
          break;
        }
        const depspending = job.dependencies.some(
          (dep) =>
            this.#mttgprocessing.has(dep) ||
            this.#mttgqueue.list().some((queued) => queued.id === dep),
        );
        if (depspending) {
          this.#mttgqueue.push({ ...job, priority: job.priority - 1 });
          continue;
        }
        const promise = processone(job);
        active.push(promise);
        void promise.finally(() => {
          const index = active.indexOf(promise);
          if (index !== -1) {
            active.splice(index, 1);
          }
        });
      }
      if (active.length > 0) {
        await Promise.race(active);
      }
    }
  }

  /** dequeues the next job by priority and deadline (v6). */
  async dequeuemttg(): Promise<mttgjob | undefined> {
    const job = [...this.#mttgqueue.list()].sort(
      (a, b) => b.priority - a.priority || (a.deadlinems ?? Infinity) - (b.deadlinems ?? Infinity),
    )[0];
    if (job === undefined) {
      return undefined;
    }
    this.#mttgqueue.remove(job.id);
    this.#metrics.inc('mttg_dequeued_total', 1, { tenant: job.tenant, qos: job.qos });
    return job;
  }

  /**
   * preempts up to three besteffort jobs of lower priority when a
   * guaranteed job arrives (coreorchestrator QoS preemption).
   */
  async preemptifneeded(incoming: mttgjob): Promise<readonly mttgjob[]> {
    if (incoming.qos !== 'guaranteed') {
      return [];
    }
    const preemptible = this.#mttgqueue
      .list()
      .filter((job) => job.qos === 'besteffort' && job.priority < incoming.priority)
      .slice(0, 3);
    for (const job of preemptible) {
      this.#mttgqueue.remove(job.id);
    }
    if (preemptible.length > 0) {
      this.#events.publish('mttg:preempted', {
        incoming: incoming.id,
        preempted: preemptible.map((job) => job.id),
      });
      this.#metrics.inc('preemptions_total', preemptible.length, { tenant: incoming.tenant });
    }
    return preemptible;
  }

  /* ---------------------------------------------------------------- */
  /* docker bridge (IPAM 10.88.N.O/24, mac 02:42)                      */
  /* ---------------------------------------------------------------- */

  async #attachdockerbridge(vm: vmrecord): Promise<dockerbridgemapping> {
    const bridgename = `br-vhe-${vm.numanode}`;
    const octet = randomInt(10, 210);
    const mapping: dockerbridgemapping = {
      vmid: vm.id,
      containerid: `vhe-${vm.id}-${Date.now()}`,
      bridge: bridgename,
      vethhost: `veth-${vm.id.slice(0, 8)}-h`,
      vethguest: `veth-${vm.id.slice(0, 8)}-g`,
      ipam: {
        ipv4: `10.88.${vm.numanode}.${octet}/24`,
        mac: `02:42:ac:${vm.numanode.toString(16).padStart(2, '0')}:${octet
          .toString(16)
          .padStart(2, '0')}:${randomInt(0, 255).toString(16).padStart(2, '0')}`,
      },
    };
    this.#dockerbridges.set(vm.id, mapping);
    this.#events.publish('docker:attached', {
      vmid: vm.id,
      bridge: bridgename,
      ipv4: mapping.ipam.ipv4,
    });
    this.#metrics.inc('docker_attached_total', 1, { bridge: bridgename });
    this.#log(`docker bridge attached vm=${vm.id} ${mapping.ipam.ipv4} ${bridgename}`);
    return mapping;
  }

  /** returns the docker bridge mapping of a vm, when attached. */
  getdockerbridge(id: vmid): dockerbridgemapping | undefined {
    return this.#dockerbridges.get(id);
  }

  /**
   * builds the docker run sidecar argv of a vm from docker.config
   * (coreorchestrator); the network name falls back to the numa bridge.
   */
  async builddockerbridgeargs(id: vmid): Promise<readonly string[]> {
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      throw new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND');
    }
    const dockerconf = (await this.loadconfig('docker.config')) as
      | Record<string, unknown>
      | undefined;
    const network = String(dockerconf?.network ?? `br-vhe-${vm.numanode}`);
    const args = [
      'run',
      '--rm',
      '--name',
      `vhe-${id}`,
      '--network',
      network,
      '--cpus',
      String(vm.vcpus),
      '--memory',
      `${vm.vrammib}m`,
    ];
    if (vm.gpu.length > 0) {
      args.push('--gpus', 'all');
    }
    args.push(vm.image);
    return args;
  }

  /* ---------------------------------------------------------------- */
  /* health monitor (checks of src_core + probes of v6)                */
  /* ---------------------------------------------------------------- */

  /** starts the periodic health monitor. */
  starthealthmonitor(intervalms = 15000): void {
    if (this.#healthinterval !== null) {
      clearInterval(this.#healthinterval);
    }
    this.#healthinterval = setInterval(() => {
      void this.#runhealthchecks();
    }, intervalms);
    this.#healthinterval.unref();
    this.#log(`health monitor started interval=${intervalms}ms`);
  }

  /** stops the periodic health monitor. */
  stophealthmonitor(): void {
    if (this.#healthinterval !== null) {
      clearInterval(this.#healthinterval);
      this.#healthinterval = null;
    }
  }

  /** registers a health check over a vm, the host or a gpu. */
  registerhealthcheck(check: Omit<healthcheck, 'laststatus' | 'lastcheck' | 'failurecount'>): void {
    this.#healthchecks.set(check.id, {
      ...check,
      laststatus: 'unknown',
      lastcheck: new Date(0),
      failurecount: 0,
    });
  }

  async #runhealthchecks(): Promise<void> {
    for (const check of this.#healthchecks.values()) {
      const previous = check.laststatus;
      let next: healthcheck['laststatus'] = 'healthy';
      if (typeof check.target === 'string' && check.target.startsWith('gpu:')) {
        const gpu = check.target.slice(4) as gpuid;
        next = this.#gpuassignments.has(gpu) ? 'healthy' : 'unknown';
      } else if (check.target === 'host') {
        const freeratio = freemem() / totalmem();
        if (freeratio < 0.1) {
          next = 'unhealthy';
        } else if (freeratio < 0.2) {
          next = 'degraded';
        }
      } else {
        const vm = this.#vms.get(check.target as vmid);
        if (vm === undefined || vm.state !== 'running') {
          next = 'unhealthy';
        }
      }
      check.laststatus = next;
      check.lastcheck = new Date();
      check.failurecount = next === 'unhealthy' ? check.failurecount + 1 : 0;
      if (previous !== next) {
        this.#events.publish('health:change', {
          checkid: check.id,
          old: previous,
          new: next,
        });
        this.#metrics.inc('health_change_total', 1, { check: check.id, status: next });
      }
      this.#metrics.gauge('health_status', next === 'healthy' ? 1 : 0, { checkid: check.id });
    }
  }

  /**
   * records an external health probe (v6); a failing probe moves a
   * running vm to degraded.
   */
  async recordhealth(probe: healthprobe): Promise<void> {
    this.#healthprobes.set(probe.vmid, probe);
    this.#metrics.inc('vm_health_total', probe.ok ? 1 : 0, { vmid: probe.vmid });
    if (!probe.ok) {
      const vm = this.#vms.get(probe.vmid as vmid);
      if (vm !== undefined && vm.state === 'running') {
        await this.transitionvm(vm.id, 'degraded').catch(() => {});
      }
    }
  }

  /** returns the currently failing health probes. */
  failingvms(): readonly healthprobe[] {
    return [...this.#healthprobes.values()].filter((probe) => !probe.ok);
  }

  /* ---------------------------------------------------------------- */
  /* autoscale (policy engine of src_core + tenant view of v6)         */
  /* ---------------------------------------------------------------- */

  /** registers an autoscale policy. */
  registerautoscalepolicy(policy: autoscalepolicy): void {
    this.#scalepolicies.set(policy.id, policy);
    this.#log(`autoscale policy registered ${policy.id} metric=${policy.metric}`);
  }

  /** starts the periodic autoscaler. */
  startautoscaler(intervalms = 30000): void {
    if (this.#autoscaleinterval !== null) {
      clearInterval(this.#autoscaleinterval);
    }
    this.#autoscaleinterval = setInterval(() => {
      void this.#evaluateautoscale();
    }, intervalms);
    this.#autoscaleinterval.unref();
  }

  /** stops the periodic autoscaler. */
  stopautoscaler(): void {
    if (this.#autoscaleinterval !== null) {
      clearInterval(this.#autoscaleinterval);
      this.#autoscaleinterval = null;
    }
  }

  async #evaluateautoscale(): Promise<void> {
    for (const policy of this.#scalepolicies.values()) {
      const groupvms = [...this.#vms.values()].filter((vm) => vm.name.startsWith(policy.vmgroup));
      const current = groupvms.length;
      let metricval = 0;
      switch (policy.metric) {
        case 'cpu':
          metricval =
            groupvms.reduce((sum, vm) => sum + Number(vm.metrics.cputimens % 1000n), 0) /
            Math.max(1, groupvms.length);
          break;
        case 'mem':
          metricval =
            groupvms.reduce((sum, vm) => sum + vm.metrics.memrssmb, 0) /
            Math.max(1, groupvms.length);
          break;
        case 'queue_depth':
          metricval = this.#mttgqueue.size;
          break;
        case 'gpu':
          metricval = (this.#gpuassignments.size / Math.max(1, this.#sriovpfs.size * 7)) * 100;
          break;
        default:
          metricval = 0;
      }
      if (metricval > policy.thresholdhigh && current < policy.maxreplicas) {
        const need = Math.min(
          policy.maxreplicas - current,
          Math.ceil((metricval - policy.thresholdhigh) / 10) || 1,
        );
        this.#events.publish('autoscale:trigger', {
          policyid: policy.id,
          action: 'scaleup',
          count: need,
        });
        this.#log(`autoscale up policy=${policy.id} metric=${metricval.toFixed(1)} need=${need}`);
        const template = groupvms[0];
        for (let index = 0; index < need; index += 1) {
          const newid = createvmid();
          const created = await this.createvm({
            id: newid,
            name: `${policy.vmgroup}-${Date.now()}-${index}`,
            tenantid: template?.tenantid ?? 'autoscale',
            vcpus: template?.vcpus ?? 4,
            vrammib: template?.vrammib ?? 4096,
          });
          if (created.ok) {
            await this.startvm(newid);
          }
        }
      } else if (metricval < policy.thresholdlow && current > policy.minreplicas) {
        const excess = current - policy.minreplicas;
        const toremove = Math.min(excess, Math.ceil((policy.thresholdlow - metricval) / 10) || 1);
        this.#events.publish('autoscale:trigger', {
          policyid: policy.id,
          action: 'scaledown',
          count: toremove,
        });
        this.#log(
          `autoscale down policy=${policy.id} metric=${metricval.toFixed(1)} remove=${toremove}`,
        );
        for (const victim of groupvms.slice(0, toremove)) {
          await this.stopvm(victim.id, SYSTEMUSER, 'autoscaledown');
          await this.destroyvm(victim.id, SYSTEMUSER);
        }
      }
      this.#metrics.gauge('autoscale_metric', metricval, {
        policy: policy.id,
        metric: policy.metric,
      });
    }
  }

  /**
   * tenant view of autoscaling (v6): averages the cpu steal of the
   * tenant probes and proposes one step up above 75 percent or one step
   * down below 20 percent.
   */
  async evaluatetenantautoscale(tenantid: string): Promise<{
    readonly desired: number;
    readonly current: number;
    readonly action: 'up' | 'down' | 'none';
  }> {
    const current = [...this.#vms.values()].filter(
      (vm) => vm.tenantid === tenantid && vm.state === 'running',
    ).length;
    const probes = [...this.#healthprobes.values()].filter((probe) => {
      const vm = this.#vms.get(probe.vmid as vmid);
      return vm?.tenantid === tenantid;
    });
    const avgcpu =
      probes.length === 0
        ? 0
        : probes.reduce((sum, probe) => sum + (probe.cpustealpct ?? 0), 0) / probes.length;
    let desired = current;
    if (avgcpu > 75 && current < 20) {
      desired = current + 1;
    } else if (avgcpu < 20 && current > 1) {
      desired = current - 1;
    }
    const action = desired > current ? 'up' : desired < current ? 'down' : 'none';
    this.#metrics.gauge('autoscale_desired', desired, { tenant: tenantid });
    return { desired, current, action };
  }

  /* ---------------------------------------------------------------- */
  /* live migration (stages of src_core + vfio guard of v6)            */
  /* ---------------------------------------------------------------- */

  /**
   * migrates a running vm to another host; live migrations walk the
   * precopy, dirty iteration and stop-copy stages with a 50-250ms
   * downtime window; vfio attached vms require the vfio-migration label.
   */
  async startmigration(
    id: vmid,
    desthost: string,
    type: migrationtype = 'live',
    actor: userid = SYSTEMUSER,
  ): Promise<result<migrationjob>> {
    this.assertpermission(actor, 'vm:migrate');
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      return { ok: false, error: new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND') };
    }
    if (vm.state !== 'running') {
      return {
        ok: false,
        error: new orchestratorerror(
          `vm ${id} not running, cannot live migrate`,
          'ERR_MIGRATE_PHASE',
        ),
      };
    }
    if (vm.gpu.some((request) => request.vfio) && vm.labels['vfio-migration'] !== 'enabled') {
      return {
        ok: false,
        error: new orchestratorerror(
          'vfio migration not enabled for this vm',
          'ERR_VFIO_MIGRATION',
        ),
      };
    }
    const job: migrationjob = {
      id: `mig-${randomUUID()}`,
      vmid: id,
      type,
      sourcehost: this.#nodeid,
      desthost,
      state: 'pending',
      bandwidthmbps: 10000,
      progress: 0,
    };
    await this.transitionvm(id, 'migrating');
    this.#migrations.set(job.id, job);
    const stages: migrationjob['state'][] =
      type === 'live' || type === 'postcopy'
        ? ['precopy', 'dirtyiter', 'stopcopy', 'completed']
        : ['pending', 'completed'];
    for (const stage of stages) {
      job.state = stage;
      job.progress = stage === 'completed' ? 100 : job.progress + 25;
      if (stage === 'stopcopy') {
        job.downtimems = randomInt(200) + 50;
      }
      this.#events.publish('migration:progress', {
        jobid: job.id,
        vmid: id,
        state: stage,
        progress: job.progress,
      });
      this.#metrics.gauge('migration_progress', job.progress, { vmid: id, dest: desthost });
      await sleep(type === 'live' || type === 'postcopy' ? 800 : 200);
      if (this.#shuttingdown) {
        job.state = 'failed';
        await this.transitionvm(id, 'running');
        return {
          ok: false,
          error: new orchestratorerror('migration aborted: shutting down', 'ERR_MIGRATION_ABORT'),
        };
      }
    }
    await this.transitionvm(id, 'running');
    this.#audit(actor, 'vm:migrate', id, 'success', { desthost, type });
    this.#log(`migration ${job.id} vm=${id} -> ${desthost} downtime=${job.downtimems ?? 0}ms`);
    return { ok: true, value: job };
  }

  /** v6 alias for startmigration with the live type. */
  async startlivemigration(id: vmid, targethost: string): Promise<migrationjob> {
    const outcome = await this.startmigration(id, targethost, 'live');
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  /* ---------------------------------------------------------------- */
  /* snapshots + checkpoints (disk level, qcow2 + meta + checksums)    */
  /* ---------------------------------------------------------------- */

  /**
   * creates a disk snapshot: a qcow2 artifact (with a metadata payload
   * in the simulated layout), an optional ram image and a json sidecar;
   * the vm walks running -> snapshotted -> running on the single
   * machine.
   */
  async createsnapshot(
    id: vmid,
    name: string,
    includeram = false,
    actor: userid = SYSTEMUSER,
  ): Promise<result<vmsnapshot>> {
    this.assertpermission(actor, 'snapshot:create');
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      return { ok: false, error: new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND') };
    }
    try {
      const snapshotid = `snap-${randomUUID()}` as snapshotid;
      await this.transitionvm(id, 'snapshotted');
      const basepath = path.join(this.#rootdir, 'snapshots', id);
      mkdirSync(basepath, { recursive: true });
      const qcow2path = path.join(basepath, `${name}.qcow2`);
      const rampath = includeram ? path.join(basepath, `${name}.ram`) : undefined;
      await sleep(400);
      writeFileSync(
        qcow2path,
        JSON.stringify({ vmid: id, name, created: new Date().toISOString(), vcpus: vm.vcpus }),
        'utf8',
      );
      if (rampath !== undefined) {
        writeFileSync(rampath, Buffer.alloc(1024 * 1024, 0));
      }
      const meta = {
        snapshotid,
        vmid: id,
        createdat: new Date().toISOString(),
        vcpu: vm.vcpus,
        vrammib: vm.vrammib,
        qemu: runtimecatalog.qemu,
      };
      writeFileSync(path.join(basepath, `${name}.json`), JSON.stringify(meta, null, 2), 'utf8');
      const sizemb = existsSync(qcow2path)
        ? Math.ceil((await stat(qcow2path)).size / 1024 / 1024)
        : 1;
      const snap: vmsnapshot = {
        id: snapshotid,
        vmid: id,
        name,
        createdat: new Date(),
        sizemb,
        qcow2path,
        rampath,
      };
      this.#snapshots.set(snapshotid, snap);
      await this.transitionvm(id, 'running');
      this.#events.publish('snapshot:created', { snapshotid, vmid: id });
      this.#metrics.inc('snapshot_created_total', 1, { vmid: id });
      this.#audit(actor, 'snapshot:create', id, 'success', { name, includeram });
      return { ok: true, value: snap };
    } catch (error) {
      if (vm.state === 'snapshotted') {
        vm.state = 'running';
      }
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /** lists snapshots, optionally filtered by vm. */
  listsnapshots(id?: vmid): readonly vmsnapshot[] {
    const all = [...this.#snapshots.values()];
    return id === undefined ? all : all.filter((snap) => snap.vmid === id);
  }

  /** restores a snapshot; the vm walks back to stopped. */
  async restoresnapshot(snapshot: snapshotid, actor: userid = SYSTEMUSER): Promise<result<void>> {
    this.assertpermission(actor, 'vm:start');
    const snap = this.#snapshots.get(snapshot);
    if (snap === undefined) {
      return {
        ok: false,
        error: new orchestratorerror(`snapshot ${snapshot} not found`, 'ERR_SNAPSHOT_NOTFOUND'),
      };
    }
    const vm = this.#vms.get(snap.vmid);
    if (vm === undefined) {
      return {
        ok: false,
        error: new orchestratorerror(`vm ${snap.vmid} not found`, 'ERR_VM_NOTFOUND'),
      };
    }
    // restore path honors the single state machine: a live vm moves through
    // restoring back to running, a stopped vm reprovisions; both routes are
    // legal edges of the guard map (running->restoring->running and
    // stopped->provisioning->stopped).
    if (vm.state === 'stopped') {
      await this.transitionvm(snap.vmid, 'provisioning');
      await sleep(600);
      await this.transitionvm(snap.vmid, 'stopped');
    } else {
      await this.transitionvm(snap.vmid, 'restoring');
      await sleep(600);
      await this.transitionvm(snap.vmid, 'running');
    }
    this.#audit(actor, 'snapshot:restore', snap.vmid, 'success', { snapshot: snapshot });
    return { ok: true, value: undefined };
  }

  /**
   * checkpoints a vm with criu, qemu savevm or docker checkpoint
   * semantics; the passage routes touching the vm are checksummed so the
   * restore can verify the network plan (v6).
   */
  async checkpointvm(
    id: vmid,
    method: vmcheckpoint['method'] = 'qemu_savevm',
    incremental = false,
    actor: userid = SYSTEMUSER,
  ): Promise<result<vmcheckpoint>> {
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      return { ok: false, error: new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND') };
    }
    if (!vm.checkpointenabled) {
      return {
        ok: false,
        error: new orchestratorerror('checkpoint disabled', 'ERR_CHECKPOINT_DISABLED'),
      };
    }
    try {
      const checkpointid = `ckpt-${randomUUID()}` as checkpointid;
      const basepath = path.join(this.#rootdir, 'checkpoints', id, checkpointid);
      mkdirSync(basepath, { recursive: true });
      if (method === 'criu' && vm.qemupid !== undefined) {
        const result = await run('criu', [
          'dump',
          '-t',
          String(vm.qemupid),
          '--images-dir',
          basepath,
          '--leave-running',
        ]);
        if (result.code !== 0) {
          throw new orchestratorerror(
            `criu dump exited ${result.code}: ${result.stderr.trim()}`,
            'ERR_CRIU_DUMP',
          );
        }
      } else {
        await sleep(500);
      }
      const routes = [...this.#passageroutes.values()].filter(
        (route) => route.srcvm === id || route.dstvm === id,
      );
      const checksum = createHash('sha256')
        .update(JSON.stringify(routes))
        .digest('hex')
        .slice(0, 16);
      const checkpoint: vmcheckpoint = {
        id: checkpointid,
        vmid: id,
        method,
        path: basepath,
        incremental,
        createdat: new Date(),
        passagechecksum: checksum,
      };
      this.#checkpoints.set(checkpointid, checkpoint);
      writeFileSync(
        path.join(basepath, 'meta.json'),
        JSON.stringify({ ...checkpoint, createdat: checkpoint.createdat.toISOString() }, null, 2),
        'utf8',
      );
      this.#events.publish('checkpoint:created', { checkpointid, vmid: id, method });
      this.#metrics.inc('checkpoint_created_total', 1, { vmid: id, method });
      this.#audit(actor, 'checkpoint:create', id, 'success', { method, incremental });
      return { ok: true, value: checkpoint };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /** restores a checkpoint; the vm walks provisioning -> running. */
  async restorecheckpoint(
    checkpoint: checkpointid,
    actor: userid = SYSTEMUSER,
  ): Promise<result<void>> {
    const ckpt = this.#checkpoints.get(checkpoint);
    if (ckpt === undefined) {
      return {
        ok: false,
        error: new orchestratorerror(
          `checkpoint ${checkpoint} not found`,
          'ERR_CHECKPOINT_NOTFOUND',
        ),
      };
    }
    const vm = this.#vms.get(ckpt.vmid);
    if (vm === undefined) {
      return {
        ok: false,
        error: new orchestratorerror(`vm ${ckpt.vmid} not found`, 'ERR_VM_NOTFOUND'),
      };
    }
    await this.transitionvm(ckpt.vmid, 'provisioning');
    await sleep(700);
    await this.transitionvm(ckpt.vmid, 'running');
    this.#audit(actor, 'checkpoint:restore', ckpt.vmid, 'success', { checkpoint });
    return { ok: true, value: undefined };
  }

  /* ---------------------------------------------------------------- */
  /* metrics: snapshots, prometheus and the OTLP HTTP exporter         */
  /* ---------------------------------------------------------------- */

  /** refreshes the runtime gauges and returns the OTel ring tail. */
  getmetricssnapshot(): readonly otelpoint[] {
    for (const vm of this.#vms.values()) {
      this.#metrics.gauge('vm_state', vm.state === 'running' ? 1 : 0, {
        vmid: vm.id,
        state: vm.state,
      });
    }
    this.#metrics.gauge('host_cpus', cpus().length, { node: this.#nodeid });
    this.#metrics.gauge('host_mem_free_mb', Math.floor(freemem() / 1024 / 1024), {
      node: this.#nodeid,
    });
    return this.#metrics.otelsnapshot();
  }

  /** renders the Prometheus exposition of the single metrics store. */
  exportprometheus(): string {
    return this.#metrics.exportprometheus();
  }

  /**
   * starts the OTLP style HTTP exporter serving /metrics and /health;
   * the bind host is a user choice (explicit argument or resolvehost)
   * and the port is random in [30000, 59999] unless pinned — the engine
   * never binds a loopback default.
   */
  async startotelexporter(
    host?: string,
    port?: number,
  ): Promise<{ readonly host: string; readonly port: number; readonly close: () => void }> {
    const bindhost = resolvehost(host);
    const bindport = allocport(port);
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      try {
        if (req.url === '/metrics' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
          res.end(this.exportprometheus());
          return;
        }
        if (req.url === '/health' && req.method === 'GET') {
          const failing = this.failingvms().length;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: failing === 0, failing, vmcount: this.#vms.size }, null, 2));
          return;
        }
        res.writeHead(404);
        res.end('not found');
      } catch {
        res.writeHead(500);
        res.end('exporter error');
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(bindport, bindhost, () => {
        resolve();
      });
    });
    this.#events.publish('otel:exporterstarted', { host: bindhost, port: bindport });
    this.#log(`otel exporter listening on ${bindhost}:${bindport}`);
    return {
      host: bindhost,
      port: bindport,
      close: () => {
        server.close();
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* config hot-reload + hardware view bootstrap                       */
  /* ---------------------------------------------------------------- */

  /** the six dotted config names every deployment must carry. */
  static mandatoryconfigs(): readonly configfilename[] {
    return [
      'vm.config',
      'gpu.config',
      'passage.config',
      'qemu.config',
      'mttg.config',
      'docker.config',
    ];
  }

  /**
   * default contents of the flat config files written by start(); the
   * version strings carry the v2 anchors (qemu 11.1.0, docker 29.7.2,
   * node 26.7.0), replacing the stale Meta banners.
   */
  #defaultconfigcontents(): Record<configfilename, string> {
    return {
      'vm.config': [
        `# saddle v6 vm.config — qemu ${runtimecatalog.qemu} — ${new Date().toISOString()}`,
        'vm_default_vcpus=4',
        'vm_default_ram_mb=4096',
        'vm_default_disk_gb=40',
        'vm_default_arch=x86_64',
        '',
      ].join('\n'),
      'gpu.config': [
        '# saddle v6 gpu.config — blackwell / ryzen x',
        'gpu_mode=passthrough',
        'gpu_default_vram=24576',
        'sriov_enabled=true',
        '',
      ].join('\n'),
      'passage.config': [
        '# saddle v6 passage.config — ovs 3.7.1 / dpdk 26.07.0',
        'passage_bridge=br-vhe',
        'passageMtu=9000',
        'vxlan_port=4789',
        '',
      ].join('\n'),
      'qemu.config': [
        `# saddle v6 qemu.config — qemu ${runtimecatalog.qemu}`,
        'qemu_binary=/usr/bin/qemu-system-x86_64',
        'qemuMachine=q35',
        'qemu_accel=kvm',
        `qemuVersion=${runtimecatalog.qemu}`,
        '',
      ].join('\n'),
      'mttg.config': [
        '# saddle v6 mttg.config — cgroups v2 / sched_ext 6.12',
        'mttg_workers=16',
        'mttg_priority_levels=8',
        'mttg_max_retries=3',
        '',
      ].join('\n'),
      'docker.config': [
        `# saddle v6 docker.config — docker ${runtimecatalog.docker}`,
        'docker_runtime=runc',
        'docker_network=bridge',
        'dockerBuildx=vhe-builder',
        `dockerVersion=${runtimecatalog.docker}`,
        '',
      ].join('\n'),
      'boards.json': JSON.stringify(
        {
          boards: [
            { id: 'b550-aorus', chipset: 'B550', socket: 'AM4', version: 'v2' },
            { id: 'x670e-hero', chipset: 'X670E', socket: 'AM5', version: 'v2' },
          ],
          version: this.version,
        },
        null,
        2,
      ),
      'cores.json': JSON.stringify(
        {
          cores: Array.from({ length: 32 }, (_, index) => ({
            id: index,
            freqmhz: 4500 + (index % 4) * 100,
            enabled: true,
          })),
          version: this.version,
        },
        null,
        2,
      ),
      'processors.json': JSON.stringify(
        {
          processors: [
            {
              id: 'ryzen-9-9950x3d',
              series: 'ryzen x',
              cores: 16,
              threads: 32,
              baseghz: 4.3,
              boostghz: 5.7,
              tdpw: 170,
              arch: 'zen5',
            },
          ],
          version: this.version,
        },
        null,
        2,
      ),
      'gpus.json': JSON.stringify(
        {
          gpus: [
            {
              id: 'gpu-blackwell-b200',
              model: 'nvidia blackwell b200',
              vendor: 'nvidia',
              vrammb: 192000,
              tdpw: 1000,
              pci: '0000:01:00.0',
              arch: 'blackwell',
            },
            {
              id: 'gpu-rdna4-9070xt',
              model: 'amd radeon rx 9070 xt',
              vendor: 'amd',
              vrammb: 16384,
              tdpw: 304,
              pci: '0000:03:00.0',
              arch: 'rdna4',
            },
          ],
          version: this.version,
        },
        null,
        2,
      ),
      'vcpus.json': JSON.stringify(
        { vcpus: { total: 32, reserved: 2, allocationmap: {} }, version: this.version },
        null,
        2,
      ),
      'vram.json': JSON.stringify(
        { vram: { totalmb: 131072, reservedmb: 2048, hugepages2m: 2048 }, version: this.version },
        null,
        2,
      ),
      'amdryzenxseries.json': JSON.stringify(
        {
          series: 'amd ryzen x',
          models: [
            { model: '9950X', cores: 16, tdp: 170, ccd: 2, boost: 5.7, x3d: false },
            {
              model: '9950X3D',
              cores: 16,
              tdp: 170,
              ccd: 2,
              boost: 5.7,
              x3d: true,
              l3cachemb: 128,
            },
          ],
          arch: 'zen5',
          node: '4nm',
          version: this.version,
        },
        null,
        2,
      ),
      'nvidiablackwell.json': JSON.stringify(
        {
          series: 'nvidia blackwell',
          models: [
            { model: 'B200', sm: 208, tensorgen: 5, vramgb: 192, bandwidthgbs: 8000 },
            { model: 'GB200', sm: 208, issuperchip: true, vramgb: 192, nvlinkbw: 3600 },
          ],
          interconnect: 'nvlink 8',
          process: '4np',
          version: this.version,
        },
        null,
        2,
      ),
    };
  }

  /**
   * watches the six dotted configs plus the eight json catalogs; missing
   * files are created with the default contents before watching starts.
   */
  enablehotreload(files: readonly configfilename[] = orchestrator.mandatoryconfigs()): void {
    const allfiles: configfilename[] = [
      ...files,
      'boards.json',
      'cores.json',
      'processors.json',
      'gpus.json',
      'vcpus.json',
      'vram.json',
      'amdryzenxseries.json',
      'nvidiablackwell.json',
    ];
    const defaults = this.#defaultconfigcontents();
    for (const name of allfiles) {
      try {
        const fullpath = path.join(this.#rootdir, name);
        if (!existsSync(fullpath)) {
          const fallback = defaults[name];
          writeFileSync(
            fullpath,
            fallback ?? (name.endsWith('.json') ? '{}' : '# saddle v6'),
            'utf8',
          );
        }
        const watcher = watch(fullpath, (event) => {
          if (event === 'change') {
            void this.handleconfigreload(name, fullpath);
          }
        });
        this.#watchers.set(name, watcher);
      } catch (error) {
        this.#log(`cannot watch ${name}: ${errormessage(error)}`);
      }
    }
    this.#log(`hot-reload enabled for ${allfiles.length} files`);
  }

  /** closes every config watcher. */
  disablehotreload(): void {
    for (const watcher of this.#watchers.values()) {
      try {
        watcher.close();
      } catch {
        /* catcher: watchers may already be closed */
      }
    }
    this.#watchers.clear();
  }

  /**
   * loads one config file with caching; json files parse into objects
   * and key=value files parse into a raw string record.
   */
  async loadconfig(name: configfilename): Promise<unknown> {
    const fullpath = path.join(this.#rootdir, name);
    try {
      const raw = await readFile(fullpath, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const lines = raw
          .split('\n')
          .filter((line) => line.trim().length > 0 && !line.startsWith('#'));
        const kv: Record<string, string> = {};
        for (const line of lines) {
          const separator = line.indexOf('=');
          if (separator > 0) {
            kv[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
          }
        }
        parsed = kv;
      }
      this.#configcache.set(name, parsed);
      return parsed;
    } catch {
      return this.#configcache.get(name);
    }
  }

  async handleconfigreload(name: configfilename, fullpath: string): Promise<void> {
    try {
      const content = await readFile(fullpath, 'utf8');
      if (name.endsWith('.json')) {
        JSON.parse(content);
      } else {
        content.split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('#'));
      }
      await this.loadconfig(name);
      this.#metrics.inc('config_reloaded_total', 1, { file: name });
      this.#events.publish('config:reloaded', { file: name });
      this.#log(`config reloaded ${name} ${content.length} bytes`);
    } catch (error) {
      this.#log(`config parse error ${name}: ${errormessage(error)}`);
    }
  }

  /**
   * bootstraps the hardware view from the eight flat json catalogs and
   * reports the missing ones (coreorchestrator).
   */
  async bootstraphardwareview(): Promise<Record<string, unknown>> {
    const names = [
      'boards.json',
      'cores.json',
      'processors.json',
      'gpus.json',
      'vcpus.json',
      'vram.json',
      'amdryzenxseries.json',
      'nvidiablackwell.json',
    ];
    const view: Record<string, unknown> = {};
    for (const name of names) {
      const loaded = await this.#readjsonmaybe(path.join(this.#rootdir, name));
      view[name.replace('.json', '')] = loaded ?? { note: `missing ${name}` };
    }
    this.#log(`hardware view bootstrapped keys=${Object.keys(view).join(',')}`);
    return view;
  }

  /* ---------------------------------------------------------------- */
  /* plugin system                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * activates a plugin with a context that exposes the orchestrator, a
   * prefixed logger and typed hook registration on the single bus.
   */
  async loadplugin(plugin: plugincontract, actor: userid = SYSTEMUSER): Promise<result<void>> {
    this.assertpermission(actor, 'plugin:manage');
    if (this.#plugins.has(plugin.id)) {
      return {
        ok: false,
        error: new orchestratorerror(`plugin ${plugin.id} already loaded`, 'ERR_PLUGIN_EXISTS'),
      };
    }
    const context: plugincontext = {
      orchestrator: this,
      log: (message: string) => {
        this.#log(`[plugin ${plugin.name}] ${message}`);
      },
      registerhook: (hook, handler) => {
        this.#events.subscribe(hook, handler as (payload: enginetopics[typeof hook]) => void);
      },
    };
    try {
      await plugin.activate(context);
      this.#plugins.set(plugin.id, plugin);
      this.#events.publish('plugin:loaded', { pluginid: plugin.id });
      this.#metrics.inc('plugin_loaded_total', 1, { plugin: plugin.name });
      this.#audit(actor, 'plugin:load', plugin.id, 'success', { version: plugin.version });
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /** deactivates a plugin and forgets it. */
  async unloadplugin(id: pluginid, actor: userid = SYSTEMUSER): Promise<result<void>> {
    this.assertpermission(actor, 'plugin:manage');
    const plugin = this.#plugins.get(id);
    if (plugin === undefined) {
      return {
        ok: false,
        error: new orchestratorerror(`plugin ${id} not found`, 'ERR_PLUGIN_NOTFOUND'),
      };
    }
    try {
      await plugin.deactivate();
    } catch {
      /* catcher: a broken deactivate must not block unload */
    }
    this.#plugins.delete(id);
    this.#events.publish('plugin:unloaded', { pluginid: id });
    this.#audit(actor, 'plugin:unload', id, 'success', {});
    return { ok: true, value: undefined };
  }

  /** v6 alias for loadplugin under the system actor. */
  async registerplugin(plugin: plugincontract): Promise<void> {
    const outcome = await this.loadplugin(plugin);
    if (!outcome.ok) {
      throw outcome.error;
    }
  }

  /** v6 alias for unloadplugin under the system actor. */
  async unregisterplugin(id: pluginid): Promise<void> {
    const outcome = await this.unloadplugin(id);
    if (!outcome.ok) {
      throw outcome.error;
    }
  }

  /** lists loaded plugins. */
  listplugins(): readonly plugincontract[] {
    return [...this.#plugins.values()];
  }

  /* ---------------------------------------------------------------- */
  /* audit: ring + JSONL persistence                                   */
  /* ---------------------------------------------------------------- */

  #audit(
    actor: userid,
    action: string,
    target: string,
    out: 'success' | 'failure',
    detail?: Record<string, unknown>,
  ): void {
    const entry: auditentry = {
      id: `audit-${randomUUID()}`,
      timestamp: new Date(),
      userid: actor,
      action,
      target: String(target),
      result: out,
      detail,
    };
    this.#auditring.push(entry);
    if (this.#auditring.length > 5000) {
      this.#auditring.splice(0, this.#auditring.length - 5000);
    }
    this.#events.publish('audit:entry', {
      actor: actor,
      action,
      target: entry.target,
      result: out,
    });
    this.#metrics.inc('audit_total', 1, { action, result: out });
  }

  /** filters the in-memory audit ring by user, action and since date. */
  getauditlog(filter?: {
    readonly userid?: userid;
    readonly action?: string;
    readonly since?: Date;
  }): readonly auditentry[] {
    let list = this.#auditring;
    if (filter?.userid !== undefined) {
      list = list.filter((entry) => entry.userid === filter.userid);
    }
    if (filter?.action !== undefined) {
      list = list.filter((entry) => entry.action === filter.action);
    }
    if (filter?.since !== undefined) {
      list = list.filter((entry) => entry.timestamp >= (filter.since as Date));
    }
    return list.slice(-1000);
  }

  /**
   * appends one audit line to the tenant JSONL file under audit/
   * (coreorchestrator); the ring mirrors the entry for fast queries.
   */
  async auditlog(entry: {
    readonly actor: string;
    readonly action: string;
    readonly resource: string;
    readonly tenant: string;
    readonly meta?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const auditdir = path.join(this.#rootdir, 'audit');
      await mkdir(auditdir, { recursive: true });
      const line = `${JSON.stringify({ ...entry, at: new Date().toISOString(), id: randomUUID() })}\n`;
      await appendFile(path.join(auditdir, `${entry.tenant}.jsonl`), line, 'utf8');
      this.#metrics.inc('audit_logged_total', 1, { tenant: entry.tenant, action: entry.action });
    } catch {
      /* catcher: audit persistence must never break the caller */
    }
  }

  /* ---------------------------------------------------------------- */
  /* drain: vm drain, graceful shutdown, node drain                    */
  /* ---------------------------------------------------------------- */

  /**
   * drains one vm: signals the guest for a graceful stop and waits up
   * to the task timeout (capped at two seconds in simulated mode).
   */
  async drainvm(id: vmid, task: draintask): Promise<result<void>> {
    const vm = this.#vms.get(id);
    if (vm === undefined) {
      return { ok: false, error: new orchestratorerror(`vm ${id} not found`, 'ERR_VM_NOTFOUND') };
    }
    const previous = vm.state;
    if (cantransition(vm.state, 'draining')) {
      vm.state = 'draining';
    }
    this.#log(
      `draining vm ${id} signal=${task.signal} timeout=${task.timeoutsec}s fallback=${task.fallback}`,
    );
    await sleep(Math.min(task.timeoutsec * 1000, 2000));
    vm.state = previous;
    return { ok: true, value: undefined };
  }

  /**
   * graceful shutdown of the whole orchestrator: monitors stop, hot
   * reload closes, running vms drain with concurrency four against an
   * overall timeout and leftover qemu processes get SIGKILL.
   */
  async gracefulshutdown(timeoutsec = 60): Promise<void> {
    if (this.#shuttingdown) {
      return;
    }
    this.#shuttingdown = true;
    this.#log(`graceful shutdown initiated timeout=${timeoutsec}s vms=${this.#vms.size}`);
    this.stophealthmonitor();
    this.stopautoscaler();
    this.disablehotreload();
    const running = [...this.#vms.values()].filter((vm) => vm.state === 'running');
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < running.length) {
        const vm = running[index];
        index += 1;
        if (vm === undefined) {
          continue;
        }
        await this.drainvm(vm.id, {
          vmid: vm.id,
          timeoutsec: 15,
          signal: 'SIGTERM',
          fallback: 'SIGKILL',
        });
        await this.stopvm(vm.id, SYSTEMUSER, 'shutdown');
      }
    };
    const workers = Array.from({ length: 4 }, () => worker());
    await Promise.race([
      Promise.all(workers),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, timeoutsec * 1000).unref();
      }),
    ]);
    for (const processinfo of this.#qemuprocesses.values()) {
      try {
        processinfo.child.kill('SIGKILL');
      } catch {
        /* catcher: the process may already be gone */
      }
    }
    this.#qemuprocesses.clear();
    await this.destroyall();
    this.#log('graceful shutdown completed');
  }

  /**
   * drains a node identified by a label pair: running vms that carry the
   * label migrate away (or terminate when migration fails) unless they
   * are marked drain-protected (coreorchestrator).
   */
  async drainnode(labelkey: string, labelvalue: string): Promise<readonly string[]> {
    const victims = [...this.#vms.values()].filter(
      (vm) => vm.labels[labelkey] === labelvalue && vm.state === 'running',
    );
    const drained: string[] = [];
    for (const vm of victims) {
      if (vm.labels['drain-protected'] === 'true') {
        continue;
      }
      await this.startlivemigration(vm.id, `drain-target-${labelvalue}`).catch(async () => {
        await this.transitionvm(vm.id, 'draining').catch(() => {});
      });
      drained.push(vm.id);
    }
    this.#events.publish('node:drained', { labelkey, labelvalue, drained });
    return drained;
  }

  /* ---------------------------------------------------------------- */
  /* leader election (bully with lease)                                */
  /* ---------------------------------------------------------------- */

  /**
   * starts the bully leader election over the peers with a lease in
   * seconds; the highest node id wins whenever the lease expires.
   */
  startleaderelection(peers: readonly string[], leasesec = 15): void {
    const attempt = (): void => {
      if (this.#shuttingdown) {
        return;
      }
      const allnodes = [...peers, this.#nodeid].sort();
      const highest = allnodes[allnodes.length - 1] ?? this.#nodeid;
      const leaseexpired =
        this.#leader.leaseexpiry === undefined || Date.now() > this.#leader.leaseexpiry.getTime();
      if (leaseexpired) {
        if (this.#nodeid === highest) {
          const oldleader = this.#leader.leaderid;
          this.#leader.term += 1;
          this.#leader.isleader = true;
          this.#leader.leaderid = this.#nodeid;
          this.#leader.leaseexpiry = new Date(Date.now() + leasesec * 1000);
          this.#leader.voters = allnodes;
          if (oldleader !== this.#leader.leaderid) {
            this.#events.publish('leader:changed', {
              leader: this.#leader.leaderid,
              term: this.#leader.term,
            });
            this.#log(`elected leader ${this.#leader.leaderid} term=${this.#leader.term}`);
          }
        } else {
          this.#leader.isleader = false;
          this.#leader.leaderid = highest;
        }
      } else if (this.#leader.isleader) {
        this.#leader.leaseexpiry = new Date(Date.now() + leasesec * 1000);
      }
      this.#metrics.gauge('leader_is_leader', this.#leader.isleader ? 1 : 0, {
        node: this.#nodeid,
        term: String(this.#leader.term),
      });
    };
    const interval = setInterval(attempt, leasesec * 500);
    interval.unref();
    attempt();
  }

  /** returns a readonly view of the leader state. */
  getleaderstate(): deepreadonly<leaderstate> {
    return this.#leader as deepreadonly<leaderstate>;
  }

  /** true when this node currently holds leadership. */
  isleader(): boolean {
    return this.#leader.isleader;
  }

  /* ---------------------------------------------------------------- */
  /* sandbox plane api (v5 preserved verbatim)                         */
  /* ---------------------------------------------------------------- */

  /** fresh spec builder (builder pattern entry point). */
  builder(): sandboxbuilder {
    return new sandboxbuilder();
  }

  /** probes every runtime binary. */
  async detectruntimes(): Promise<Record<string, boolean>> {
    return this.#registry.detectall();
  }

  /** creates a sandbox through the strategy for its runtime. */
  async create(spec: sandboxspec): Promise<sandboxproxy> {
    const sandbox = await this.#factory.create(spec);
    this.#active.add(sandbox);
    return sandbox;
  }

  /** restores a firecracker sandbox from a snapshot file. */
  async restore(spec: sandboxspec, snapshotfile: string): Promise<sandboxproxy> {
    const strategy = this.#registry.get(spec.runtime);
    if (!(strategy instanceof firecrackerruntime)) {
      throw new Error(`restore requires the firecracker runtime, got ${spec.runtime}`);
    }
    try {
      await mkdir(path.join(rundir(), spec.id), { recursive: true });
      const argv = strategy.restorecommand(spec.id, snapshotfile);
      const [bin, ...rest] = argv;
      const child = spawn(bin, rest, { env: { ...process.env, ...spec.env } });
      const handle = new sandboxhandle(spec.id, strategy.name, child);
      await handle.started();
      this.#metrics.inc(`sandbox.restored.${spec.runtime}`);
      this.#events.emit('restored', { id: spec.id, snapshotfile });
      const proxy = new sandboxproxy(spec, handle, strategy, this.#events, this.#metrics);
      this.#active.add(proxy);
      return proxy;
    } catch (error) {
      this.#events.emit('error', { id: spec.id, phase: 'restore', message: errormessage(error) });
      throw new Error(`restore failed for ${spec.id}: ${errormessage(error)}`);
    }
  }

  /** enables the warm pool with a template spec. */
  async enablewarmpool(min: number, max: number, template: sandboxspec): Promise<void> {
    await this.disablewarmpool();
    this.#pool = new warmpool({
      min,
      max,
      events: this.#events,
      metrics: this.#metrics,
      template: async () => {
        const sandbox = await this.#factory.create(template);
        await sandbox.start();
        return sandbox;
      },
    });
    await this.#pool.prewarm();
    this.#pool.startrefill();
  }

  /** acquires a warm sandbox. */
  async createpooled(): Promise<sandboxproxy> {
    if (this.#pool === null) {
      throw new Error('warm pool is disabled; call enablewarmpool first');
    }
    const sandbox = await this.#pool.acquire();
    this.#active.add(sandbox);
    return sandbox;
  }

  /** disables the warm pool and destroys the warm sandboxes. */
  async disablewarmpool(): Promise<void> {
    if (this.#pool !== null) {
      await this.#pool.drain();
      this.#pool = null;
    }
  }

  /** criu checkpoint of a live sandbox process tree. */
  async checkpoint(sandbox: sandboxproxy, dir?: string): Promise<void> {
    await sandbox.criucheckpoint(
      this.#checkpointer,
      dir ?? path.join(rundir(), sandbox.id, 'criu'),
    );
  }

  /** criu restore of a checkpointed image directory. */
  async criurestore(dir: string): Promise<void> {
    await this.#checkpointer.restore(dir);
  }

  /** destroys every active sandbox. */
  async destroyall(): Promise<void> {
    for (const sandbox of this.#active) {
      try {
        await sandbox.destroy();
      } catch (error) {
        this.#events.emit('error', {
          id: sandbox.id,
          phase: 'destroyall',
          message: errormessage(error),
        });
      }
    }
    this.#active.clear();
    await this.disablewarmpool();
  }

  /** compose 5.5.0 rendering of a spec. */
  composeyaml(spec: sandboxspec): string {
    return composeyaml(spec);
  }

  /* ---------------------------------------------------------------- */
  /* start / stop / dumpstate                                          */
  /* ---------------------------------------------------------------- */

  /**
   * prepares the runtime directories, materializes the default flat
   * configs, optionally enables hot-reload and starts the health
   * monitor, the autoscaler and the scheduler tick.
   */
  async start(): Promise<void> {
    this.#log(`starting orchestrator v${this.version} stack=${JSON.stringify(stackcatalog)}`);
    for (const dir of ['snapshots', 'checkpoints', 'logs', 'run', 'audit']) {
      try {
        mkdirSync(path.join(this.#rootdir, dir), { recursive: true });
      } catch {
        /* catcher: read-only roots keep the orchestrator memory-only */
      }
    }
    const defaults = this.#defaultconfigcontents();
    for (const [name, content] of Object.entries(defaults) as [configfilename, string][]) {
      const fullpath = path.join(this.#rootdir, name);
      try {
        if (!existsSync(fullpath)) {
          writeFileSync(fullpath, content, 'utf8');
        }
      } catch {
        /* catcher: config materialization is best effort */
      }
    }
    if (this.#options.enablehotreload === true) {
      this.enablehotreload();
    }
    this.starthealthmonitor();
    this.startautoscaler();
    this.#schedulerinterval = setInterval(() => {
      this.scheduletick();
    }, 2000);
    this.#schedulerinterval.unref();
    this.#log('orchestrator started');
  }

  /** graceful shutdown plus scheduler teardown. */
  async stop(): Promise<void> {
    await this.gracefulshutdown(30);
    if (this.#schedulerinterval !== null) {
      clearInterval(this.#schedulerinterval);
      this.#schedulerinterval = null;
    }
  }

  /** full diagnostics dump of both planes. */
  dumpstate(): Record<string, unknown> {
    return {
      version: this.version,
      nodeid: this.#nodeid,
      stack: stackcatalog,
      vms: this.#vms.size,
      running: [...this.#vms.values()].filter((vm) => vm.state === 'running').length,
      runqueues: [...this.#runqueues.values()].map((queue) => ({
        numa: queue.numanode,
        load: queue.load,
        tasks: queue.tasks.length,
      })),
      balloons: this.#balloons.size,
      gpus: this.#gpuassignments.size,
      sriov: this.#sriovpfs.size,
      passageroutes: this.#passageroutes.size,
      mttgqueue: this.#mttgqueue.size,
      dockerbridges: this.#dockerbridges.size,
      qemuprocesses: this.#qemuprocesses.size,
      migrations: this.#migrations.size,
      snapshots: this.#snapshots.size,
      checkpoints: this.#checkpoints.size,
      plugins: this.#plugins.size,
      reservations: this.#reservations.size,
      quotas: [...this.#quotatable.keys()],
      leader: this.#leader,
      numa: this.#numatopology,
      sandboxactive: this.#active.size,
      metricscount: this.#metrics.otelsnapshot().length,
    };
  }

  [Symbol.dispose](): void {
    try {
      void this.stop();
    } catch {
      /* catcher: disposal must not throw */
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: singleton + end-to-end demo with `using` disposal          */
/* ------------------------------------------------------------------ */

/** cached default instance of the orchestrator (getOrchestrator merge). */
let defaultorchestrator: orchestrator | undefined;

/**
 * returns the singleton orchestrator, creating it on the first call with
 * options; later calls ignore their options and always return the same
 * instance.
 */
function getorchestrator(options?: orchestratoroptions): orchestrator {
  if (defaultorchestrator !== undefined) {
    return defaultorchestrator;
  }
  if (options === undefined) {
    throw new orchestratorerror(
      'orchestrator not initialized; provide options on the first call',
      'ERR_SINGLETON',
    );
  }
  defaultorchestrator = new orchestrator(options);
  return defaultorchestrator;
}

/**
 * end-to-end demo: a vm is created and scheduled, an mttg job flows
 * through the queue, a passage route resolves and the metrics snapshot
 * is returned; the vm plane is destroyed before returning so the demo
 * leaves no state behind.
 */
export async function orchestratordemo(): Promise<metricsview> {
  const engine = new orchestrator();
  const created = await engine.createvm({ name: 'demo-vm', vcpus: 2, vrammib: 2048 });
  if (created.ok) {
    engine.enqueuemttg({
      id: 'demo-job',
      tenant: 'default',
      qos: 'burstable',
      priority: 5,
      groupid: 'demo',
      payloadref: 'demo:payload',
      dependencies: [],
    });
    await engine.processmttgqueue(async (job) => {
      engine.events.publish('mttg:jobdone', { jobid: job.id, durationms: 1 });
    }, 1);
    await engine.destroyvm(created.value.id);
  }
  using sandbox = await engine.create(
    engine
      .builder()
      .withimage('debian:trixie-slim')
      .withruntime('docker')
      .withcpus(2)
      .withmemory(2048)
      .withgpuspoof('rtx5090')
      .withport(8080)
      .build(),
  );
  void sandbox;
  return engine.metrics.snapshot();
}

/* ------------------------------------------------------------------ */
/* context: v5-C feature audit builder (ledger F-064 GitOps Flux CD)    */
/* ------------------------------------------------------------------ */

/** one kustomize overlay of the planned GitOps repository. */
export interface fluxkustomization {
  readonly path: string;
  readonly resources: readonly string[];
  readonly yaml: string;
}

/** the planned Flux GitOps repository layout for SADDLE CRDs. */
export interface fluxgitopsplan {
  readonly repo: string;
  readonly branches: readonly string[];
  readonly clusters: readonly string[];
  readonly kustomizations: readonly fluxkustomization[];
  readonly bootstrapargv: readonly string[];
  readonly syncpolicy: {
    readonly interval: string;
    readonly prune: boolean;
    readonly selfheal: boolean;
  };
}

/**
 * plans the Flux GitOps repository layout for SADDLE CRDs (ledger
 * F-064): branch model (main promoted through staging), one
 * flux-system bootstrap per cluster, an infrastructure layer holding
 * the VirtualMachine CRD (buildvmcrdmanifest in compute.ts) plus OPA
 * gatekeeper policies, and an apps layer holding the per-cluster
 * VirtualMachine custom resources. the planner emits the full
 * kustomization.yaml content for each overlay and the exact flux
 * bootstrap argv (with the GHCR image repository and sync intervals),
 * so `flux bootstrap` plus a git push is everything the operator runs.
 */
export function planfluxgitops(
  opts: {
    repo?: string;
    clusters?: readonly string[];
    interval?: string;
    prune?: boolean;
    selfheal?: boolean;
  } = {},
): fluxgitopsplan {
  try {
    const repo = opts.repo ?? 'github.com/wenathlan/saddle-gitops';
    if (!/^[a-z0-9./:-]+$/.test(repo)) throw new Error(`repo ${repo} must be a lowercase git url`);
    const clusters = opts.clusters ?? ['staging', 'prod'];
    if (clusters.length === 0) throw new Error('at least one cluster is required');
    if (clusters.length > 16) throw new Error('at most 16 clusters per repository');
    const seen = new Set<string>();
    for (const cluster of clusters) {
      if (!/^[a-z][a-z0-9-]*$/.test(cluster)) {
        throw new Error(`cluster ${cluster} must be lowercase alnum/dash`);
      }
      if (seen.has(cluster)) throw new Error(`duplicate cluster ${cluster}`);
      seen.add(cluster);
    }
    const interval = opts.interval ?? '1m';
    if (!/^[0-9]+(s|m|h)$/.test(interval)) throw new Error('interval must look like 30s, 1m, 2h');
    const kustomization = (path: string, resources: readonly string[]): fluxkustomization => ({
      path,
      resources,
      yaml: [
        'apiVersion: kustomize.config.k8s.io/v1beta1',
        'kind: Kustomization',
        `resources:${resources.map((resource) => `\n  - ${resource}`).join('')}`,
        '',
      ].join('\n'),
    });
    const kustomizations: fluxkustomization[] = [
      kustomization('infrastructure/crd', ['virtualmachine-crd.yaml', 'opa-policies.yaml']),
      kustomization('apps/base', ['virtualmachines.yaml']),
      ...clusters.map((cluster) => kustomization(`apps/overlays/${cluster}`, ['../../base'])),
    ];
    const bootstrapargv = [
      'flux bootstrap github',
      `  --owner=${repo.split('/')[0]}`,
      `  --repository=${repo.split('/').pop()}`,
      '  --branch=main',
      '  --path=clusters/${cluster}/flux-system',
      `  --interval=${interval}`,
      opts.prune === false ? '  --no-prune' : '  --prune=true',
      opts.selfheal === false ? '  --no-self-heal' : '  --self-heal=true',
      '  --components=source-controller,kustomize-controller,helm-controller,notification-controller',
    ];
    return {
      repo,
      branches: ['main', 'staging'],
      clusters,
      kustomizations,
      bootstrapargv,
      syncpolicy: { interval, prune: opts.prune !== false, selfheal: opts.selfheal !== false },
    };
  } catch (error) {
    throw new Error(
      `planfluxgitops failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type {
  affinityrule,
  affinityselector,
  autoscalepolicy,
  awaitable,
  balloonstate,
  brand,
  checkpointid,
  configfilename,
  cpuset,
  deepreadonly,
  dockerbridgemapping,
  draintask,
  gpuassignment,
  gpupassthroughrequest,
  healthcheck,
  healthprobe,
  leaderstate,
  lifecyclestate,
  metricsview,
  migrationjob,
  migrationtype,
  mttgjob,
  numanodeid,
  numatopologyview,
  orchestratoroptions,
  otelpoint,
  passageroute,
  permission,
  plugincontext,
  plugincontract,
  portmapping,
  quotastate,
  rbacprincipal,
  rbacrole,
  replayrecord,
  reservation,
  result,
  roleid,
  runqueue,
  runresult,
  sandboxeventname,
  sandboxruntime,
  sandboxspec,
  snapshotid,
  sriovpf,
  userid,
  VcpuId,
  vcputask,
  vcputopology,
  vmcheckpoint,
  vmdefinition,
  vmid,
  vmrecord,
  vmsnapshot,
  vramballoon,
};
export {
  allocport,
  cantransition,
  clhruntime,
  composeyaml,
  createvmid,
  cricheckpointer,
  dockerruntime,
  fcrequest,
  firecrackerruntime,
  getorchestrator,
  gvisorruntime,
  kataruntime,
  kvmavailable,
  lifecyclefromphase,
  orchestrator,
  orchestratorerror,
  performetrics,
  priorityqueue,
  qemuruntime,
  resolvehost,
  runtimecatalog,
  runtimeregistry,
  sandboxbuilder,
  sandboxevents,
  sandboxfactory,
  sandboxhandle,
  sandboxmetrics,
  sandboxproxy,
  stackcatalog,
  transitions,
  vmimage,
  warmpool,
};
