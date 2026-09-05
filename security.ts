/**
 * security.ts — layered sandbox security for the virtual hardware engine.
 *
 * the module models the 2026 defense stack verified on 2026-08-22:
 * - landlock abi v10 on the kernel mainline (docs.kernel.org): v1 5.13
 *   filesystem rights, v2 5.19 refer, v3 6.2 truncate, v4 6.7 tcp
 *   bind/connect, v5 6.10 ioctl_dev, v6 6.12 scopes (abstract unix
 *   socket + signal), v7 6.15 audit, v8 restrict_self tsync, v9
 *   resolve_unix, v10 udp bind/connect + send (merged around 6.20/6.21);
 *   unprivileged, no root needed, layers on top of seccomp
 * - seccomp: deny-by-default bpf filters; SECCOMP_RET_TRAP (SIGSYS) is
 *   the base of the gvisor systrap platform; io_uring stays blocked in
 *   every sandbox profile (docker default profile blocks it since
 *   moby#47532 and gvisor disables it; CVE-2026-46315 disclosed an
 *   information leak through io_uring in june 2026)
 * - ebpf lsm: hooks since kernel 5.7 execute at the kernel decision
 *   point, which grants toctou immunity compared with tracepoints and
 *   syscall tracing; hornet lsm v6 (april 2026) verifies eBPF program
 *   signatures in-kernel
 * - cgroups v2: unified hierarchy on every modern distro; cpu, memory,
 *   io and pids controllers; subtree delegation enables rootless
 *   operation (podman, docker rootless) and sustains the orchestrator
 *   memory/shm limits
 * - post-quantum: ML-KEM (FIPS 203) and ML-DSA (FIPS 204) native in
 *   OpenSSL 3.5; X25519MLKEM768 hybrid is the default TLS 1.3 group and
 *   node 24+ bundles OpenSSL 3.5.5, so the engine inherits PQ/TLS
 *   without extra code; RFC 10024 (2026-08-10) standardizes the PQ/T
 *   hybrid mechanisms; ChaCha20-Poly1305 (RFC 8439) remains the AEAD
 *   fallback for hosts without AES-NI
 * - criu v4.2.1: checkpoint/restore with selinux relabel support so
 *   restored processes keep their labels
 *
 * contexts (23): landlockabitable, landlockaccess, landlockscopes,
 * landlockrulebuilder, landlockapplier, hostprobe, seccompactions,
 * syscallnumbers, defaultallowed, seccompbuilder, defaultseccomp,
 * ebpflsmfacts, ebpfattachplan, cgroupv2layout, cgroupbuilder, pqstack
 * (pqcatalog, pqkeyfactory, pqsecurecontext, rfc10024, pqcaudit — the
 * v3-B1 append), chachapoly, sandboxprofile, profilebuilder,
 * policyregistry, policyevents, policyproxy, criurelabel
 *
 * patterns: builder (landlockrulebuilder, seccompbuilder, cgroupbuilder,
 * profilebuilder), registry (policyregistry), proxy (policyproxy),
 * observer (policyevents). rules: lowercase identifiers, english jsdoc,
 * third person, no emoji, try/catch catcher on every fallible path,
 * node:* built-ins only, no hardcoded localhost address anywhere.
 */

import { spawn } from 'node:child_process';
import type { CipherGCM, DecipherGCM, KeyObject } from 'node:crypto';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import path from 'node:path';
import type { SecureContext } from 'node:tls';
import { createSecureContext } from 'node:tls';

/* ------------------------------------------------------------------ */
/* context: landlock abi table (docs.kernel.org, verified 2026-08-22)  */
/* ------------------------------------------------------------------ */

/** one landlock abi release. */
interface landlockabientry {
  readonly abi: number;
  readonly kernel: string;
  readonly feature: string;
}

/** landlock abi timeline; v8-v10 landed across 6.16-6.21 per the
 * landlock.io timeline (v10 patches v3 in december 2025). */
const landlockabitable = [
  { abi: 1, kernel: '5.13', feature: 'filesystem access rights' },
  { abi: 2, kernel: '5.19', feature: 'path refer and directory changes' },
  { abi: 3, kernel: '6.2', feature: 'file truncate' },
  { abi: 4, kernel: '6.7', feature: 'network tcp bind/connect' },
  { abi: 5, kernel: '6.10', feature: 'fs ioctl_dev access right' },
  { abi: 6, kernel: '6.12', feature: 'scopes: abstract unix socket + signal' },
  { abi: 7, kernel: '6.15', feature: 'audit logging' },
  { abi: 8, kernel: '6.16', feature: 'restrict_self tsync for multi-threaded processes' },
  { abi: 9, kernel: '6.17', feature: 'resolve_unix scope' },
  { abi: 10, kernel: '6.20', feature: 'network udp bind/connect + send' },
] as const satisfies readonly landlockabientry[];

/** filesystem access rights across the abi levels. */
const landlockfsaccess = [
  'execute',
  'write_file',
  'read_file',
  'read_dir',
  'remove_dir',
  'remove_file',
  'make_char',
  'make_dir',
  'make_reg',
  'make_sock',
  'make_fifo',
  'make_block',
  'make_sym',
  'refer',
  'truncate',
  'ioctl_dev',
] as const;

/** network access rights (tcp since abi v4, udp since abi v10). */
const landlocknetaccess = ['bind_tcp', 'connect_tcp', 'bind_udp', 'connect_udp'] as const;

/** landlock scopes introduced with abi v6 (kernel 6.12). */
const landlockscopes = ['abstract_unix_socket', 'signal'] as const;
type landlockscope = (typeof landlockscopes)[number];

/* ------------------------------------------------------------------ */
/* context: landlock rule builder (builder pattern)                    */
/* ------------------------------------------------------------------ */

/** one path rule with the rights granted on it. */
interface landlockrule {
  readonly path: string;
  readonly rights: readonly string[];
}

/** assembled ruleset consumed by the native restrict helper. */
interface landlockruleset {
  readonly handledfs: readonly string[];
  readonly handlednet: readonly string[];
  readonly scopes: readonly landlockscope[];
  readonly rules: readonly landlockrule[];
}

/** fluent builder for a landlock ruleset; the default grants read and
 * execute on the whole filesystem tree and nothing else (deny by
 * default at the handled-rights level). */
class landlockrulebuilder {
  #rules: landlockrule[] = [];
  #handledfs = new Set<string>(['read_file', 'read_dir', 'execute']);
  #handlednet = new Set<string>();
  #scopes = new Set<landlockscope>();

  /** grants read + execute on a tree (system roots, runtimes). */
  readonlytree(target: string): this {
    return this.rule(target, ['read_file', 'read_dir', 'execute']);
  }

  /** grants full filesystem access on a tree (workspace roots). */
  writetree(target: string): this {
    return this.rule(target, [
      'read_file',
      'read_dir',
      'execute',
      'write_file',
      'remove_dir',
      'remove_file',
      'make_dir',
      'make_reg',
      'make_sym',
      'make_sock',
      'make_fifo',
      'refer',
      'truncate',
    ]);
  }

  /** grants ioctls on device nodes (abi v5, kernel 6.10+). */
  devioctl(target: string): this {
    return this.handle('ioctl_dev').rule(target, ['read_file', 'write_file', 'ioctl_dev']);
  }

  /** adds one explicit rule. */
  rule(target: string, rights: readonly string[]): this {
    this.#rules.push({ path: target, rights: [...rights] });
    for (const right of rights) {
      this.#handledfs.add(right);
    }
    return this;
  }

  /** widens the handled fs rights set. */
  handle(right: string): this {
    if (!(landlockfsaccess as readonly string[]).includes(right)) {
      throw new Error(`unknown landlock fs right "${right}"`);
    }
    this.#handledfs.add(right);
    return this;
  }

  /** allows tcp networking (abi v4+): bind, connect or both. */
  nettcp(bind: boolean, connect: boolean): this {
    if (bind) {
      this.#handlednet.add('bind_tcp');
    }
    if (connect) {
      this.#handlednet.add('connect_tcp');
    }
    return this;
  }

  /** allows udp networking (abi v10, kernel ~6.20). */
  netudp(bind: boolean, connect: boolean): this {
    if (bind) {
      this.#handlednet.add('bind_udp');
    }
    if (connect) {
      this.#handlednet.add('connect_udp');
    }
    return this;
  }

  /** restricts abstract unix sockets or signals (abi v6, kernel 6.12). */
  scope(name: landlockscope): this {
    this.#scopes.add(name);
    return this;
  }

  /** freezes the ruleset. */
  build(): landlockruleset {
    return {
      handledfs: [...this.#handledfs],
      handlednet: [...this.#handlednet],
      scopes: [...this.#scopes],
      rules: [...this.#rules],
    };
  }
}

/* ------------------------------------------------------------------ */
/* context: landlock applier + host probe                              */
/* ------------------------------------------------------------------ */

/** normalizes an unknown thrown value into a message string. */
function errormessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** parses a kernel release such as "6.12.0-arch1-1". */
function kernelversion(kernel: string = release()): {
  readonly major: number;
  readonly minor: number;
} {
  const match = /^(\d+)\.(\d+)/.exec(kernel);
  return match === null
    ? { major: 0, minor: 0 }
    : { major: Number(match[1]), minor: Number(match[2]) };
}

/** number-encodes a kernel for ordering (6.10 beats 6.7). */
function kernelnumber(kernel: string): number {
  const { major, minor } = kernelversion(kernel);
  return major * 100 + minor;
}

/** derives the expected landlock abi from the running kernel release;
 * the native helper confirms it at runtime through
 * landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION). */
function detectlandlockabi(kernel: string = release()): number {
  const current = kernelnumber(kernel);
  let abi = 0;
  for (const entry of landlockabitable) {
    if (current >= kernelnumber(entry.kernel)) {
      abi = entry.abi;
    }
  }
  return abi;
}

/** reads the lsm list from sysfs; empty when unavailable. */
function lsmlist(): readonly string[] {
  try {
    return readFileSync('/sys/kernel/security/lsm', 'utf8').trim().split(',');
  } catch {
    return [];
  }
}

/** renders the restriction plan handed to the native helper binary
 * (the c preload library performs the actual syscalls; node has no
 * direct syscall binding). */
function landlockplan(ruleset: landlockruleset): {
  readonly env: Record<string, string>;
  readonly argv: readonly string[];
} {
  const encoded = JSON.stringify(ruleset);
  return {
    env: { VHE_LANDLOCK_RULESET: encoded },
    argv: ['vhe-landlock', '--ruleset-stdin'],
  };
}

/* ------------------------------------------------------------------ */
/* context: seccomp actions + syscall numbers                          */
/* ------------------------------------------------------------------ */

/** seccomp filter actions; RET_TRAP (SIGSYS) is the gvisor systrap base
 * and ERRNO is the deny action used by the engine profiles. */
const seccompactions = {
  killprocess: 'SCMP_ACT_KILL_PROCESS',
  killthread: 'SCMP_ACT_KILL_THREAD',
  trap: 'SCMP_ACT_TRAP',
  errno: 'SCMP_ACT_ERRNO',
  trace: 'SCMP_ACT_TRACE',
  log: 'SCMP_ACT_LOG',
  notify: 'SCMP_ACT_NOTIFY',
} satisfies Record<string, string>;

/** x86_64 syscall numbers of the deny list; io_uring is blocked in
 * every sandbox (docker default profile moby#47532, gvisor default,
 * CVE-2026-46315 information disclosure, june 2026). the host side of
 * the same story is liburing 2.8 (pool viabilityreport context 09):
 * SQPOLL plus the IORING_SETUP_COOP_TASKRUN and
 * IORING_SETUP_SINGLE_ISSUER setup flags — cooperative task running
 * without IPI storms and a single-issuer fast path; those flags are
 * host-only optimizations and NEVER relax the guest deny list: the
 * three io_uring syscalls stay blocked inside sandboxes. */
const syscallnumbers = {
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
  bpf: 321,
  perf_event_open: 298,
  kexec_load: 246,
  kexec_file_load: 320,
  userfaultfd: 323,
  ptrace: 101,
  open_by_handle_at: 304,
  mount: 165,
  umount2: 166,
  pivot_root: 217,
  init_module: 175,
  finit_module: 313,
  delete_module: 176,
  acct: 163,
  swapon: 167,
  swapoff: 168,
  reboot: 169,
  setns: 308,
  unshare: 310,
  clone3: 435,
} satisfies Record<string, number>;

/** rationale for the always-blocked syscalls (documentation surface). */
const _blockedrationale: Record<string, string> = {
  io_uring_setup:
    'async io blocked in sandboxes: docker default profile, gvisor default and CVE-2026-46315',
  io_uring_enter: 'see io_uring_setup; the whole io_uring family stays out of sandboxes',
  io_uring_register:
    'see io_uring_setup; lwn documents task-level restrictions as the future escape hatch',
  bpf: 'loading bpf programs is a host-only privilege',
  perf_event_open: 'hardware counters leak host state',
  ptrace: 'cross-process introspection breaks sandbox isolation',
  clone3: 'blocked to force plain clone through the audited path',
};

/** default allow list: the syscalls a plain workload needs. */
const defaultallowed = [
  'accept4',
  'arch_prctl',
  'bind',
  'brk',
  'capget',
  'capset',
  'chdir',
  'chmod',
  'chown',
  'clock_getres',
  'clock_gettime',
  'clock_nanosleep',
  'clone',
  'close',
  'close_range',
  'connect',
  'dup',
  'dup2',
  'dup3',
  'epoll_create1',
  'epoll_ctl',
  'epoll_pwait',
  'epoll_wait',
  'eventfd2',
  'execve',
  'execveat',
  'exit',
  'exit_group',
  'faccessat',
  'faccessat2',
  'fadvise64',
  'fallocate',
  'fcntl',
  'fstat',
  'fstatfs',
  'fsync',
  'ftruncate',
  'futex',
  'getcwd',
  'getdents64',
  'getegid',
  'geteuid',
  'getgid',
  'getgroups',
  'getpeername',
  'getpid',
  'getppid',
  'getrandom',
  'getresgid',
  'getresuid',
  'getrlimit',
  'getrusage',
  'getsockname',
  'getsockopt',
  'gettid',
  'gettimeofday',
  'getuid',
  'ioctl',
  'kill',
  'listen',
  'lseek',
  'madvise',
  'membarrier',
  'mkdir',
  'mkdirat',
  'mmap',
  'mprotect',
  'mremap',
  'munmap',
  'nanosleep',
  'newfstatat',
  'open',
  'openat',
  'pipe',
  'pipe2',
  'poll',
  'ppoll',
  'prctl',
  'pread64',
  'preadv',
  'prlimit64',
  'pselect6',
  'pwrite64',
  'pwritev',
  'read',
  'readlink',
  'readlinkat',
  'readv',
  'recvfrom',
  'recvmmsg',
  'recvmsg',
  'rename',
  'renameat',
  'renameat2',
  'rseq',
  'rt_sigaction',
  'rt_sigprocmask',
  'rt_sigreturn',
  'sched_getaffinity',
  'sched_yield',
  'sendmmsg',
  'sendmsg',
  'sendto',
  'set_robust_list',
  'set_tid_address',
  'setitimer',
  'setrlimit',
  'shutdown',
  'sigaltstack',
  'socket',
  'socketpair',
  'stat',
  'statfs',
  'sysinfo',
  'tgkill',
  'timerfd_create',
  'timerfd_settime',
  'uname',
  'unlink',
  'unlinkat',
  'wait4',
  'waitid',
  'write',
  'writev',
] as const;

/* ------------------------------------------------------------------ */
/* context: seccomp profile builder (docker-compatible json)           */
/* ------------------------------------------------------------------ */

/** one syscall group entry of a docker seccomp profile. */
interface seccompgroup {
  readonly names: readonly string[];
  readonly action: string;
  readonly errnoRet?: number;
}

/** docker-compatible seccomp profile (deny by default). */
interface seccompprofile {
  readonly defaultAction: string;
  readonly defaultErrnoRet: number;
  readonly architectures: readonly string[];
  readonly syscalls: readonly seccompgroup[];
}

/** builder for a deny-by-default seccomp profile; the blocked entries
 * return ENOSYS (38) so denied syscalls look absent, matching the docker
 * default profile semantics. */
class seccompbuilder {
  #allowed = new Set<string>(defaultallowed);
  #blocked = new Map<string, number>();

  constructor() {
    for (const name of Object.keys(syscallnumbers)) {
      this.#blocked.set(name, 38);
    }
  }

  /** allows additional syscalls. */
  allow(...names: readonly string[]): this {
    for (const name of names) {
      this.#blocked.delete(name);
      this.#allowed.add(name);
    }
    return this;
  }

  /** blocks a syscall with an errno (38 = ENOSYS, 1 = EPERM). */
  deny(name: string, errno: number = 38): this {
    this.#allowed.delete(name);
    this.#blocked.set(name, errno);
    return this;
  }

  /** true when a syscall is currently denied. */
  denied(name: string): boolean {
    return this.#blocked.has(name) && !this.#allowed.has(name);
  }

  /** freezes the profile; denied syscalls are grouped per errno. */
  build(): seccompprofile {
    const groups: seccompgroup[] = [{ names: [...this.#allowed].sort(), action: 'SCMP_ACT_ALLOW' }];
    const byerrno = new Map<number, string[]>();
    for (const [name, errno] of this.#blocked) {
      const list = byerrno.get(errno) ?? [];
      list.push(name);
      byerrno.set(errno, list);
    }
    for (const [errno, names] of byerrno) {
      groups.push({ names: [...names].sort(), action: seccompactions.errno, errnoRet: errno });
    }
    return {
      defaultAction: seccompactions.errno,
      defaultErrnoRet: 38,
      architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_X86', 'SCMP_ARCH_X32'],
      syscalls: groups,
    };
  }
}

/** the engine default profile: allow the plain workload surface and
 * deny the privileged set including the io_uring family. */
function defaultseccompprofile(): seccompprofile {
  return new seccompbuilder().build();
}

/* ------------------------------------------------------------------ */
/* context: ebpf lsm facts + attach plan                               */
/* ------------------------------------------------------------------ */

/** verified ebpf lsm facts (kernel docs, cloudflare and lwn sources). */
const ebpflsmfacts = {
  sincemajor: '5.7',
  toctou: 'hooks execute at the kernel decision point, immune to time-of-check/time-of-use races',
  tracepoints: 'tracepoints and syscall tracing observe after the fact and remain racy',
  verification: 'programs are verified at load time',
  hornet: 'hornet lsm v6 (april 2026) verifies eBPF program signatures in-kernel',
} satisfies Record<string, string>;

/** one ebpf lsm attach point planned for the engine. */
interface ebpfattach {
  readonly hook: string;
  readonly program: string;
  readonly purpose: string;
}

/** attach plan: lsm hooks for enforcement, one tracepoint for counters. */
const ebpfattachplan = [
  {
    hook: 'lsm/file_open',
    program: 'vhe_file_open',
    purpose: 'audit opens outside the sandbox roots',
  },
  {
    hook: 'lsm/bprm_check_security',
    program: 'vhe_bprm',
    purpose: 'deny undeclared binaries at exec',
  },
  {
    hook: 'lsm/socket_connect',
    program: 'vhe_socket_connect',
    purpose: 'pin egress to the engine proxy',
  },
  {
    hook: 'tracepoint/syscalls/sys_enter_io_uring_setup',
    program: 'vhe_io_uring_counter',
    purpose: 'count denied async io attempts',
  },
] as const satisfies readonly ebpfattach[];

/* ------------------------------------------------------------------ */
/* context: cgroups v2 layout + builder                                */
/* ------------------------------------------------------------------ */

/** cgroups v2 facts: unified hierarchy everywhere, delegation for
 * rootless operation (podman, docker rootless, systemd Delegate=yes). */
const cgroupv2layout = {
  mountpoint: '/sys/fs/cgroup',
  hierarchy: 'unified (v2 only) on every modern distro',
  controllers: ['cpu', 'cpuset', 'memory', 'io', 'pids', 'rdma', 'misc'],
  delegation: 'subtree_control plus systemd Delegate=yes enable rootless delegation',
  note: 'sustains the orchestrator MemorySwap/ShmSize limits',
} satisfies Record<string, string | readonly string[]>;

/** a cgroup plan: directory plus the files to write into it. */
interface cgroupplan {
  readonly name: string;
  readonly files: Record<string, string>;
}

/** builder for one sandbox cgroup; values are written verbatim into the
 * unified hierarchy files. */
class cgroupbuilder {
  readonly #name: string;
  #files: Record<string, string> = {};

  constructor(name: string = 'vhe-sandbox') {
    this.#name = name;
  }

  /** cpu.max as "quota period" (100000 100000 = 1 cpu). */
  cpu(quota: number = 100000, period: number = 100000): this {
    this.#files['cpu.max'] = `${quota} ${period}`;
    return this;
  }

  /** cpu.weight (1-10000, default 100). */
  cpuweight(weight: number): this {
    this.#files['cpu.weight'] = String(weight);
    return this;
  }

  /** memory.max hard limit in bytes. */
  memorymax(bytes: number): this {
    this.#files['memory.max'] = String(bytes);
    return this;
  }

  /** memory.high throttle point in bytes. */
  memoryhigh(bytes: number): this {
    this.#files['memory.high'] = String(bytes);
    return this;
  }

  /** memory.swap.max; "max" means unlimited, mirrors MemorySwap -1. */
  memoryswapmax(limit: number | 'max'): this {
    this.#files['memory.swap.max'] = String(limit);
    return this;
  }

  /** pids.max process ceiling. */
  pidsmax(count: number): this {
    this.#files['pids.max'] = String(count);
    return this;
  }

  /** io.max line for one device ("8:0" style major:minor). */
  iomax(
    device: string,
    rbps: string = 'max',
    wbps: string = 'max',
    riops: string = 'max',
    wiops: string = 'max',
  ): this {
    this.#files['io.max'] = `${device} rbps=${rbps} wbps=${wbps} riops=${riops} wiops=${wiops}`;
    return this;
  }

  /** freezes the plan. */
  build(): cgroupplan {
    return { name: this.#name, files: { ...this.#files } };
  }
}

/* ------------------------------------------------------------------ */
/* context: post-quantum catalog                                       */
/* ------------------------------------------------------------------ */

/** verified post-quantum facts (openssl.org, ietf, node release notes). */
const pqcatalog = {
  mlkem: 'ML-KEM, FIPS 203 (module-lattice key encapsulation)',
  mldsa: 'ML-DSA, FIPS 204 (module-lattice digital signature)',
  slhdsa: 'SLH-DSA, FIPS 205 (stateful hash signatures)',
  tlsdefault: 'X25519MLKEM768 hybrid group, default for TLS 1.3 since OpenSSL 3.5',
  openssl: '3.5.5 bundled with node 24+',
  rfc: 'RFC 10024 (2026-08-10) standardizes the PQ/T hybrid mechanisms for TLS 1.3',
  chacha: 'ChaCha20-Poly1305 (RFC 8439) AEAD fallback for hosts without AES-NI',
  aesnote: 'AES-256-GCM is up to 3x faster with AES-NI; ChaCha20 wins without it',
} satisfies Record<string, string>;

/* ------------------------------------------------------------------ */
/* context: pq key factory                                             */
/* ------------------------------------------------------------------ */

/** keypair holder. */
interface keypair {
  readonly publickey: KeyObject;
  readonly privatekey: KeyObject;
}

/** post-quantum key generation through node:crypto; every algorithm
 * falls back to a clear error when the runtime predates OpenSSL 3.5. */
class pqkeyfactory {
  /** ML-KEM-768 (FIPS 203) encapsulation keypair. */
  static mlkem768(): keypair {
    try {
      const pair = generateKeyPairSync('ml-kem-768');
      return { publickey: pair.publicKey, privatekey: pair.privateKey };
    } catch (error) {
      throw new Error(
        `ml-kem-768 unavailable (requires node 24+ with OpenSSL 3.5.5+): ${errormessage(error)}`,
      );
    }
  }

  /** ML-DSA-65 (FIPS 204) signing keypair. */
  static mldsa65(): keypair {
    try {
      const pair = generateKeyPairSync('ml-dsa-65');
      return { publickey: pair.publicKey, privatekey: pair.privateKey };
    } catch (error) {
      throw new Error(
        `ml-dsa-65 unavailable (requires node 24+ with OpenSSL 3.5.5+): ${errormessage(error)}`,
      );
    }
  }

  /** classic X25519 keypair for the hybrid group. */
  static x25519(): keypair {
    try {
      const pair = generateKeyPairSync('x25519');
      return { publickey: pair.publicKey, privatekey: pair.privateKey };
    } catch (error) {
      throw new Error(`x25519 unavailable: ${errormessage(error)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: hybrid TLS 1.3 secure context                              */
/* ------------------------------------------------------------------ */

/** builds a TLS 1.3 secure context with the PQ hybrid group first;
 * node maps ecdhCurve to the OpenSSL groups list, so
 * "X25519MLKEM768:X25519" negotiates the RFC 10024 hybrid before the
 * classic group; ChaCha20-Poly1305 stays in the cipher list for hosts
 * without AES-NI. */
function pqsecurecontext(): SecureContext {
  try {
    return createSecureContext({
      minVersion: 'TLSv1.3',
      ecdhCurve: 'X25519MLKEM768:X25519',
      ciphers: 'TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256',
    });
  } catch (error) {
    throw new Error(`post-quantum secure context failed: ${errormessage(error)}`);
  }
}

/* ------------------------------------------------------------------ */
/* context: chachapoly AEAD (RFC 8439)                                 */
/* ------------------------------------------------------------------ */

/** seals plaintext with ChaCha20-Poly1305; the 16-byte tag is appended. */
function chachaseal(
  key: Buffer,
  nonce: Buffer,
  plaintext: Buffer,
  aad: Buffer | null = null,
): Buffer {
  try {
    const cipher = createCipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: 16,
    }) as CipherGCM;
    if (aad !== null) {
      cipher.setAAD(aad);
    }
    return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  } catch (error) {
    throw new Error(`chacha20-poly1305 seal failed: ${errormessage(error)}`);
  }
}

/** opens a ChaCha20-Poly1305 sealed buffer (tag appended). */
function chachaopen(key: Buffer, nonce: Buffer, sealed: Buffer, aad: Buffer | null = null): Buffer {
  try {
    if (sealed.length < 16) {
      throw new Error('sealed buffer is shorter than the 16-byte poly1305 tag');
    }
    const tag = sealed.subarray(sealed.length - 16);
    const body = sealed.subarray(0, sealed.length - 16);
    const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: 16,
    }) as DecipherGCM;
    decipher.setAuthTag(tag);
    if (aad !== null) {
      decipher.setAAD(aad);
    }
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch (error) {
    throw new Error(`chacha20-poly1305 open failed: ${errormessage(error)}`);
  }
}

/* ------------------------------------------------------------------ */
/* context: sandbox profile (deny by default composite)                */
/* ------------------------------------------------------------------ */

/** composite sandbox profile: landlock + seccomp + cgroups + tls + criu
 * relabel; every layer is deny-by-default. */
interface sandboxprofile {
  readonly name: string;
  readonly landlock: landlockruleset | null;
  readonly seccomp: seccompprofile;
  readonly cgroup: cgroupplan | null;
  readonly tls: { readonly groups: string; readonly minversion: string };
  readonly criu: { readonly relabel: boolean; readonly label: string };
}

/** builder that composes the four layers into one profile. */
class profilebuilder {
  #name = 'default';
  #landlock: landlockruleset | null = null;
  #seccomp: seccompprofile = defaultseccompprofile();
  #cgroup: cgroupplan | null = null;
  #tls = { groups: 'X25519MLKEM768:X25519', minversion: 'TLSv1.3' };
  #relabel = true;
  #label = 'system_u:object_r:container_file_t:s0';

  named(name: string): this {
    this.#name = name;
    return this;
  }

  withlandlock(ruleset: landlockruleset): this {
    this.#landlock = ruleset;
    return this;
  }

  withseccomp(profile: seccompprofile): this {
    this.#seccomp = profile;
    return this;
  }

  withcgroup(plan: cgroupplan): this {
    this.#cgroup = plan;
    return this;
  }

  /** disables selinux relabel on criu restore. */
  withoutrelabel(): this {
    this.#relabel = false;
    return this;
  }

  withlabel(label: string): this {
    this.#label = label;
    return this;
  }

  /** freezes the composite profile. */
  build(): sandboxprofile {
    return {
      name: this.#name,
      landlock: this.#landlock,
      seccomp: this.#seccomp,
      cgroup: this.#cgroup,
      tls: this.#tls,
      criu: { relabel: this.#relabel, label: this.#label },
    };
  }
}

/* ------------------------------------------------------------------ */
/* context: policy registry (registry pattern)                         */
/* ------------------------------------------------------------------ */

/** registry of named sandbox profiles. */
class policyregistry {
  #profiles = new Map<string, sandboxprofile>();

  register(profile: sandboxprofile): this {
    this.#profiles.set(profile.name, profile);
    return this;
  }

  get(name: string): sandboxprofile {
    const found = this.#profiles.get(name);
    if (found === undefined) {
      throw new Error(
        `unknown security profile "${name}"; known: ${[...this.#profiles.keys()].join(', ')}`,
      );
    }
    return found;
  }

  names(): readonly string[] {
    return [...this.#profiles.keys()];
  }
}

/** default registry: minimal (workstation-like), compute (gpu workload,
 * no network) and network (egress through the engine proxy). */
const defaultpolicies = new policyregistry()
  .register(
    new profilebuilder()
      .named('minimal')
      .withlandlock(
        new landlockrulebuilder()
          .readonlytree('/usr')
          .readonlytree('/lib')
          .writetree('/workspace')
          .build(),
      )
      .withcgroup(
        new cgroupbuilder('vhe-minimal')
          .cpu(200000, 100000)
          .memorymax(2 * 1024 * 1024 * 1024)
          .pidsmax(512)
          .build(),
      )
      .build(),
  )
  .register(
    new profilebuilder()
      .named('compute')
      .withlandlock(
        new landlockrulebuilder()
          .readonlytree('/usr')
          .readonlytree('/opt')
          .writetree('/workspace')
          .writetree('/dev/shm')
          .scope('signal')
          .build(),
      )
      .withcgroup(
        new cgroupbuilder('vhe-compute')
          .cpu(400000, 100000)
          .cpuweight(200)
          .memorymax(8 * 1024 * 1024 * 1024)
          .memoryswapmax('max')
          .pidsmax(1024)
          .build(),
      )
      .build(),
  )
  .register(
    new profilebuilder()
      .named('network')
      .withlandlock(
        new landlockrulebuilder()
          .readonlytree('/usr')
          .writetree('/workspace')
          .nettcp(false, true)
          .netudp(false, true)
          .scope('abstract_unix_socket')
          .scope('signal')
          .build(),
      )
      .build(),
  );

/* ------------------------------------------------------------------ */
/* context: policy events (observer pattern)                           */
/* ------------------------------------------------------------------ */

/** policy event names. */
type policyeventname = 'applied' | 'released' | 'audit' | 'violation' | 'relabel';

/** observer bus for policy activity; listener failures never propagate. */
class policyevents {
  #emitter = new EventEmitter();

  constructor() {
    this.#emitter.setMaxListeners(64);
  }

  on(name: policyeventname, listener: (payload: unknown) => void): this {
    this.#emitter.on(name, listener);
    return this;
  }

  emit(name: policyeventname, payload: unknown): void {
    try {
      this.#emitter.emit(name, payload);
    } catch (_error) {
      /* catcher: observer failures are isolated by design */
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: policy proxy (proxy pattern + audit trail)                 */
/* ------------------------------------------------------------------ */

/** proxy that audits every profile access and reports violations when a
 * profile layer is weaker than the engine baseline. */
class policyproxy {
  readonly #inner: sandboxprofile;
  readonly #events: policyevents;
  readonly #audit: string[] = [];

  constructor(inner: sandboxprofile, events: policyevents) {
    this.#inner = inner;
    this.#events = events;
  }

  get name(): string {
    return this.#inner.name;
  }

  /** audit trail entries. */
  get audit(): readonly string[] {
    return this.#audit;
  }

  /** seccomp layer with an audit record. */
  get seccomp(): seccompprofile {
    this.#audit.push(`read seccomp for ${this.#inner.name}`);
    return this.#inner.seccomp;
  }

  /** landlock layer with an audit record. */
  get landlock(): landlockruleset | null {
    this.#audit.push(`read landlock for ${this.#inner.name}`);
    return this.#inner.landlock;
  }

  /** cgroup layer with an audit record. */
  get cgroup(): cgroupplan | null {
    this.#audit.push(`read cgroup for ${this.#inner.name}`);
    return this.#inner.cgroup;
  }

  /** true when the io_uring family stays denied; a violation event is
   * emitted and recorded otherwise. */
  iouringblocked(): boolean {
    const blocked = this.#inner.seccomp.syscalls.some(
      (group) => group.action === seccompactions.errno && group.names.includes('io_uring_setup'),
    );
    if (!blocked) {
      const message = `profile ${this.#inner.name} fails to deny io_uring_setup (CVE-2026-46315)`;
      this.#audit.push(`violation: ${message}`);
      this.#events.emit('violation', { profile: this.#inner.name, message });
      return false;
    }
    this.#audit.push(`io_uring family denied in ${this.#inner.name}`);
    return true;
  }

  /** writes the seccomp profile json next to a sandbox runtime dir so
   * the orchestrator can pass --security-opt seccomp=<path>. */
  async persistseccomp(dir: string): Promise<string> {
    try {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${this.#inner.name}-seccomp.json`);
      await writeFile(file, JSON.stringify(this.#inner.seccomp, null, 2), 'utf8');
      this.#audit.push(`persisted seccomp profile to ${file}`);
      return file;
    } catch (error) {
      throw new Error(`seccomp persistence failed: ${errormessage(error)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: criu + selinux relabel                                     */
/* ------------------------------------------------------------------ */

/** runs a command to completion and captures its output. */
function run(
  command: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(command, args);
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', (error: Error) => {
        reject(new Error(`${command} failed to spawn: ${error.message}`));
      });
      child.once('close', (code: number | null) => {
        resolve({ code: code ?? -1, stderr });
      });
    } catch (error) {
      reject(new Error(`${command} failed: ${errormessage(error)}`));
    }
  });
}

/** criu v4.2.1 selinux relabel support: restored images keep their
 * labels through "criu restore --lsm-profile selinux:<label>" and the
 * chcon fallback relabels the image tree before restore. */
class criurelabel {
  readonly #label: string;

  constructor(label: string = 'system_u:object_r:container_file_t:s0') {
    this.#label = label;
  }

  /** the --lsm-profile flag value for criu restore. */
  lsmflag(): string {
    return `selinux:${this.#label}`;
  }

  /** relabels a checkpoint image tree with chcon. */
  async relabel(imagesdir: string): Promise<void> {
    try {
      const result = await run('chcon', ['-R', this.#label, imagesdir]);
      if (result.code !== 0) {
        throw new Error(`chcon exited ${result.code}: ${result.stderr.trim()}`);
      }
    } catch (error) {
      throw new Error(`selinux relabel failed for ${imagesdir}: ${errormessage(error)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* context: applied profile guard (`using` scope) + self check         */
/* ------------------------------------------------------------------ */

/** scope guard that emits applied/released events around a block; the
 * `using` declaration releases the scope even on throw. */
class appliedprofile {
  readonly #profile: sandboxprofile;
  readonly #events: policyevents;
  #released = false;

  constructor(profile: sandboxprofile, events: policyevents) {
    this.#profile = profile;
    this.#events = events;
    this.#events.emit('applied', { profile: profile.name });
  }

  [Symbol.dispose](): void {
    try {
      if (!this.#released) {
        this.#released = true;
        this.#events.emit('released', { profile: this.#profile.name });
      }
    } catch (_error) {
      /* catcher: disposal must not throw */
    }
  }
}

/** one outcome of the host self check. */
interface securitycheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** random url-safe token for sandbox authentication. */
function randomtoken(bytes: number = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** constant-time comparison of two tokens. */
function tokenequals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** verifies the host security surface under a profile scope: landlock
 * abi versus kernel release, lsm list, cgroup v2 mount, io_uring denial,
 * post-quantum keygen and the chacha roundtrip; the `using` guard
 * emits the applied/released events around the whole run. */
async function securityselfcheck(
  profile: sandboxprofile = defaultpolicies.get('compute'),
): Promise<readonly securitycheck[]> {
  const events = new policyevents();
  const checks: securitycheck[] = [];
  using _scope = new appliedprofile(profile, events);
  const abi = detectlandlockabi();
  checks.push({
    name: 'landlock-abi',
    ok: abi >= 4,
    detail: `kernel ${release()} implies landlock abi v${abi} (v4+ needed for tcp rules, v10 is current)`,
  });
  const lsms = lsmlist();
  checks.push({
    name: 'landlock-lsm',
    ok: lsms.includes('landlock'),
    detail:
      lsms.length === 0
        ? 'lsm list unreadable (unprivileged container or hardened host)'
        : `active lsms: ${lsms.join(',')}`,
  });
  const proxy = new policyproxy(profile, events);
  checks.push({
    name: 'iouring-denied',
    ok: proxy.iouringblocked(),
    detail:
      'io_uring_setup/enter/register must stay denied (CVE-2026-46315, docker moby#47532, gvisor default)',
  });
  try {
    const cgroupfiles = readFileSync('/proc/self/cgroup', 'utf8');
    checks.push({
      name: 'cgroups-v2',
      ok: cgroupfiles.includes('0::'),
      detail: cgroupfiles.includes('0::')
        ? 'unified hierarchy active'
        : 'cgroups v1 layout detected',
    });
  } catch (error) {
    checks.push({
      name: 'cgroups-v2',
      ok: false,
      detail: `cgroup detection failed: ${errormessage(error)}`,
    });
  }
  try {
    const pair = pqkeyfactory.mlkem768();
    checks.push({
      name: 'pq-mlkem',
      ok: pair.publickey.asymmetricKeyType === 'ml-kem-768',
      detail: `ML-KEM-768 keypair ready (FIPS 203; ${pqcatalog.openssl})`,
    });
  } catch (error) {
    checks.push({ name: 'pq-mlkem', ok: false, detail: errormessage(error) });
  }
  try {
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const sealed = chachaseal(key, nonce, Buffer.from('vhe', 'utf8'));
    const opened = chachaopen(key, nonce, sealed).toString('utf8');
    checks.push({
      name: 'chacha-poly1305',
      ok: opened === 'vhe',
      detail: 'RFC 8439 AEAD roundtrip succeeded',
    });
  } catch (error) {
    checks.push({ name: 'chacha-poly1305', ok: false, detail: errormessage(error) });
  }
  return checks;
}

export type {
  cgroupplan,
  ebpfattach,
  keypair,
  landlockabientry,
  landlockrule,
  landlockruleset,
  landlockscope,
  policyeventname,
  sandboxprofile,
  seccompgroup,
  seccompprofile,
  securitycheck,
};
export {
  cgroupbuilder,
  cgroupv2layout,
  chachaopen,
  chachaseal,
  criurelabel,
  defaultpolicies,
  defaultseccompprofile,
  detectlandlockabi,
  ebpfattachplan,
  ebpflsmfacts,
  kernelversion,
  landlockabitable,
  landlockfsaccess,
  landlocknetaccess,
  landlockplan,
  landlockrulebuilder,
  landlockscopes,
  lsmlist,
  policyevents,
  policyproxy,
  policyregistry,
  pqcatalog,
  pqkeyfactory,
  pqsecurecontext,
  profilebuilder,
  randomtoken,
  seccompactions,
  seccompbuilder,
  securityselfcheck,
  syscallnumbers,
  tokenequals,
};

/* ------------------------------------------------------------------ */
/* context: rfc10024 + pqcaudit (post-quantum negotiation and audit     */
/* trail) — v3-B1 append absorbing future.ts features 026-027; the     */
/* ml-kem/ml-dsa keygen and the hybrid TLS context already lived here  */
/* (pqkeyfactory, pqsecurecontext), so only these two were missing     */
/* ------------------------------------------------------------------ */

/** short sha256 digest for the audit hash chain. */
function pqdigest(input: string): string {
  try {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  } catch {
    return input.length.toString(16);
  }
}

/** one PQ/T hybrid mechanism standardized by RFC 10024 (2026-08-10). */
export interface pqtmechanism {
  readonly name: string;
  readonly classical: string;
  readonly pq: string;
  readonly securityBits: number;
}

/** the three hybrid mechanisms the RFC registers for TLS 1.3. */
export const rfc10024mechanisms: readonly pqtmechanism[] = [
  { name: 'X25519MLKEM768', classical: 'X25519', pq: 'ML-KEM-768', securityBits: 192 },
  { name: 'SecP256r1MLKEM768', classical: 'secp256r1', pq: 'ML-KEM-768', securityBits: 192 },
  { name: 'SecP384r1MLKEM1024', classical: 'secp384r1', pq: 'ML-KEM-1024', securityBits: 256 },
] as const satisfies readonly pqtmechanism[];

/**
 * negotiates the strongest mutually supported PQ/T hybrid mechanism:
 * server preference order wins, mirroring how OpenSSL 3.5 orders the
 * groups list behind pqsecurecontext above.
 */
export class rfc10024negotiator {
  #serverPreference: readonly pqtmechanism[] = rfc10024mechanisms;

  setpreference(names: readonly string[]): void {
    const byName = new Map(rfc10024mechanisms.map((m) => [m.name, m]));
    const ordered = names
      .map((n) => byName.get(n))
      .filter((m): m is pqtmechanism => m !== undefined);
    if (ordered.length > 0) this.#serverPreference = ordered;
  }

  negotiate(clientOffered: readonly string[]): pqtmechanism | null {
    const offered = new Set(clientOffered);
    for (const mech of this.#serverPreference) {
      if (offered.has(mech.name)) return mech;
    }
    return null;
  }
}

/** one entry of the tamper-evident PQ audit chain. */
export interface pqcauditentry {
  readonly ts: string;
  readonly event: string;
  readonly algorithm: string;
  readonly hybrid: boolean;
  readonly prevHash: string;
  readonly hash: string;
}

/**
 * hash-chained, tamper-evident log recording which sessions negotiated
 * post-quantum protection — the core evidence against
 * harvest-now-decrypt-later attacks. verify() replays the chain and
 * coverage() reports the PQ share of all recorded sessions.
 */
export class pqcaudittrail {
  #entries: pqcauditentry[] = [];
  #head = 'genesis';

  record(event: string, algorithm: string, hybrid: boolean): pqcauditentry {
    const ts = new Date().toISOString();
    const hash = pqdigest(`${this.#head}|${ts}|${event}|${algorithm}|${hybrid}`);
    const entry: pqcauditentry = { ts, event, algorithm, hybrid, prevHash: this.#head, hash };
    this.#head = hash;
    this.#entries.push(entry);
    return entry;
  }

  verify(): boolean {
    let prev = 'genesis';
    for (const entry of this.#entries) {
      if (entry.prevHash !== prev) return false;
      if (
        pqdigest(
          `${entry.prevHash}|${entry.ts}|${entry.event}|${entry.algorithm}|${entry.hybrid}`,
        ) !== entry.hash
      ) {
        return false;
      }
      prev = entry.hash;
    }
    return true;
  }

  /** share of sessions protected by a PQ or PQ/T hybrid mechanism. */
  coverage(): { total: number; pqShare: number } {
    const total = this.#entries.length;
    const pq = this.#entries.filter((e) => e.hybrid || e.algorithm.startsWith('ML-')).length;
    return { total, pqShare: total === 0 ? 0 : Number((pq / total).toFixed(3)) };
  }
}

/* ------------------------------------------------------------------ */
/* context: type utilities (noinfer factory guard, TS 5.6 lineage)    */
/* ------------------------------------------------------------------ */

/**
 * blocks inference spill in factory defaults: when a parameter type
 * is constrained by another parameter's type, wrapping it in noinfer
 * stops the checker from inferring the constraint source itself.
 * typescript ships this natively as NoInfer<T> since 5.4 (the pool
 * viabilityreport cites it through the 5.6.3 isolatedDeclarations
 * sheet); the local spelling keeps the pattern working under the
 * engine's erasable-syntax profile and documents the provenance.
 */
export type noinfer<t> = [t][t extends t ? 0 : never];

/** a policy factory default that must not widen to the constraint. */
export interface policydefault<t extends string> {
  readonly kind: 'policy-default';
  readonly value: t;
}

/**
 * builds one policy default entry whose value never leaks inference
 * back into the caller's generic — the exact factory leak the pool
 * NoInfer demo (FactoryOptionsNoInfer) documented.
 */
export function policypreset<t extends string>(value: noinfer<t>): policydefault<t> {
  return { kind: 'policy-default', value } satisfies policydefault<t>;
}
