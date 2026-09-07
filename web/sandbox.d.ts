/**
 * type declarations for web/sandbox.js: the browser-pure port of the
 * virtual hardware engine (procfs payloads, the 89-char smi table,
 * mesa summaries, boot dmesg and the command dispatcher). the module
 * stays plain javascript (server.js imports it from node without a
 * build step); this declaration file gives the React console typed
 * access to the same surface the static console.html consumed.
 */

/** reviewed processor catalog entry (mirrors the vendor pages). */
export type CpuSpec = {
  model: string;
  displayname: string;
  vendor: string;
  arch: string;
  cores: number;
  threads: number;
  baseclockmhz: number;
  boostclockmhz: number;
  allcoreclockmhz: number;
  l3mb: number;
  l2mb: number;
  socket: string;
  tdpwatts: number;
  pcie: string;
  maxmemorygb: number;
  memorytype: string;
  memorychannels: number;
  microarch: string;
  launch: string;
};

/** reviewed virtual gpu catalog entry. */
export type GpuSpec = {
  id: string;
  name: string;
  vendor: string;
  pcivendor: string;
  pcidevice: string;
  vrammib: number;
  smireportedmib: number;
  memtype: string;
  busbits: number;
  bandwidthgbs: number;
  tdpwatts: number;
  arch: string;
  smarch: string;
  smcount: number;
  mig: boolean;
  driver: string;
  cuda: string | null;
};

/** one mig slicing profile of the 96 gb-class device. */
export type MigProfile = {
  id: string;
  slicegb: number;
  maxinstances: number;
};

/** sandbox specification accepted by createSandboxState. */
export type SandboxSpec = {
  model: string;
  vcpus?: number;
  ramgb?: number;
  gpu: string;
  mig?: string;
  id?: string;
};

/** resolved smp topology for a virtual cpu spec. */
export type CpuTopology = {
  threadspercore: number;
  coresonline: number;
  vcpus: number;
};

/** one persistent workspace file entry. */
export type SandboxFile = {
  content: string;
  size: number;
  updatedat: string;
};

/** the filesystem contract shared by the api host and the memoryfs. */
export type SandboxFs = {
  write: (path: string, content: string) => { path: string; size: number; updatedat: string };
  read: (path: string) => (SandboxFile & { path: string }) | null;
  list: () => Array<{ path: string; size: number; updatedat: string }>;
  del: (path: string) => boolean;
};

/** state object shared by the browser terminal and the api exec endpoint. */
export type SandboxState = {
  model: string;
  cpuspec: CpuSpec;
  gpuspec: GpuSpec;
  vcpus: number;
  ramgb: number;
  gpu: string;
  mig: string;
  id: string;
  hostname: string;
  boottime: number;
  kernel: string;
  memsnapshot: string;
  history: string[];
  files: Map<string, SandboxFile>;
};

/** command result matching the api exec contract. */
export type DispatchResult = {
  output: string;
  exitCode: number;
};

/** optional exec context provided by the api host. */
export type DispatchContext = {
  fs?: SandboxFs;
  quota?: number;
};

/** the reviewed processor catalog (8 models). */
export const cpudata: CpuSpec[];

/** the reviewed virtual gpu catalog (7 models). */
export const gpudata: GpuSpec[];

/** the mig catalog of the 96 gb-class virtual device. */
export const migprofiles: MigProfile[];

/** the supported command list, reused by help and the terminal. */
export const commands: string[];

/** resolves a cpu spec by model name, case-insensitive. */
export function getcpu(model: string): CpuSpec | undefined;

/** resolves a cpu spec by catalog id, case-insensitive. */
export function getcpubyid(id: string): CpuSpec | undefined;

/** resolves a gpu spec by id or name, case-insensitive. */
export function getgpu(gpu: string): GpuSpec | undefined;

/** resolves a mig profile by id; null for "off" and unknown names. */
export function getmig(id: string): MigProfile | null;

/** resolves the smp topology for a virtual cpu spec. */
export function solvetopology(spec: CpuSpec, vcpus: number): CpuTopology;

/** renders the full procfs cpuinfo payload for a model and vcpu count. */
export function cpuinfo(model: string, vcpus: number): string;

/** renders the lscpu topology summary (numanodes defaults to 1). */
export function lscpu(model: string, vcpus: number, numanodes?: number): string;

/** rounds a kb value down to the nearest 4 kb page boundary. */
export function pagealign(kb: number): number;

/** generates a complete /proc/meminfo payload for the requested ram. */
export function meminfo(
  ramgb: number,
  options?: {
    swapgb?: number;
    vcpus?: number;
    freefraction?: number;
    availablefraction?: number;
  },
): string;

/** renders the human readable free -h table from a meminfo payload. */
export function freeh(meminfotext: string): string;

/** renders the 89-char nvidia-smi table for a gpu and mig profile. */
export function nvidiaSmiTable(gpu: string, migprofile?: string): string;

/** renders the nvidia-smi -L device listing. */
export function nvidiaSmiList(gpu: string, migprofile?: string): string;

/** renders the rusticl opencl summary on llvmpipe. */
export function clinfoSummary(vcpus?: number): string;

/** renders the lavapipe vulkan summary. */
export function vulkanSummary(): string;

/** renders the llvmpipe opengl summary. */
export function glxinfoSummary(): string;

/** renders the mesa llvmpipe environment block. */
export function mesaenv(vcpus?: number): string;

/** renders the animated boot dmesg sequence for a sandbox spec. */
export function bootSequence(
  model: string,
  vcpus: number,
  ramgb?: number,
  gpu?: string,
  quota?: number,
): string[];

/**
 * creates the state object shared by the browser terminal and the api
 * exec endpoint: resolved specs, a stable hostname, the boot timestamp
 * and a memoized meminfo snapshot.
 */
export function createSandboxState(spec: SandboxSpec): SandboxState;

/**
 * dispatches one shell command against a sandbox state; the return
 * shape matches the api exec contract. without a context the commands
 * run on the per-session in-memory workspace.
 */
export function dispatch(command: string, state: SandboxState, context?: DispatchContext): DispatchResult;

/** renders the quantum layer summary (fully classical simulation). */
export function quantumdemo(): string;

/** renders the layered virtual memory tier summary. */
export function tiersdemo(): string;

/** renders the streaming memory plan for an oversized workload. */
export function streamingdemo(totalbytes?: number, windowbytes?: number): string;
