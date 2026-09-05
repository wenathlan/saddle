/**
 * tiers - the "everything is VRAM" virtual memory layer of saddle.
 *
 * The v17 doctrine: in the end everything is VRAM. The VM impersonates
 * physical hardware the way browsers spoof headers, and the only physical
 * memory allowed lives in GitHub files (artifacts/GHCR), free bucket
 * accounts and the npm CDNs. This module implements that vision on four
 * tiers: L1 ram (Map working set plus SharedArrayBuffer ring), L2 vram
 * (compute-bound tier of the catalog), L3 storage ram (repositories: a
 * real node:sqlite kvstore, the npm chunk farm, GitHub REST) and L4
 * external buckets (hf, kaggle, terabox, r2, storj, turso). It ships a
 * real WAL SQLite backend with LRU eviction, the npm chunk planner with
 * jsDelivr/UNPKG/esm.run URLs, a GitHub REST client that degrades to
 * planner mode without a token, the VDR 64-bit BigInt address space with
 * a ring that auto-flushes at the 512 MB ceiling and demotes blocks into
 * L3, printable kernel bridge recipes (zram/tmpfs/swap/mmap/sysctl/
 * cgroups v2), the storage==compute thesis with a real magic byte
 * sniffer, and the memoryengine facade. Zero dependencies, node:* only,
 * native fetch, no localhost, no emoji.
 *
 * Contexts (24): tierserror; TIERS catalog; LATENCYLADDER +
 * autoscalebysize; FREEPOOL quotas; sqlitekv (WAL/LRU); storagebackend +
 * rambufferbackend; sqlitel3backend; zip codec (crc32/zipbuild/zipread);
 * plannpmchunks + reassembleplan + publishplan; npmchunkregistry;
 * githubstorage (artifacts/releases/blobs); VDR addressing + memoryblock
 * + vrdblockheaders; pagetable + localpagetable; upstashplanner;
 * vrdringbuffer; universalvdrengine; kernel recipes (zram/tmpfs/swap);
 * storagerambridgeplanner (mmap); sysctldropin + cgroupsv2slice;
 * sniffmagic + virtualfilesystem; memoryengine; creatiersengine;
 * quotaplanner (hf/kaggle/terabox/r2/storj/forges); tiersreport.
 *
 * Canonical sources: readme1.md lines 367-534 (memory 7-tier model,
 * MemoryEngine API, storage to RAM bridge, SQLite as RAM), 505-519
 * (free pool and quotas), 898-913 (VDR design). Toolchain TS 7.0.2.
 */

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';

/* ------------------------------------------------------------------ */
/* Section 1: errors                                                   */
/* ------------------------------------------------------------------ */

/** Error thrown by every tiers subsystem with an optional cause chain. */
export class tierserror extends Error {
  /** Machine readable subsystem tag. */
  readonly subsystem: string;

  constructor(message: string, options?: { cause?: Error; subsystem?: string }) {
    super(message, options);
    this.name = 'tierserror';
    this.subsystem = options?.subsystem ?? 'tiers';
  }
}

/** Wraps a fallible callback into a tierserror with subsystem context. */
function guard<T>(subsystem: string, what: string, body: () => T): T {
  try {
    return body();
  } catch (cause) {
    if (cause instanceof tierserror) {
      throw cause;
    }
    throw new tierserror(`${what} failed`, { cause: cause as Error, subsystem });
  }
}

/* ------------------------------------------------------------------ */
/* Section 2: tier model (L1..L4, everything is VRAM)                  */
/* ------------------------------------------------------------------ */

/** Identifiers of the four virtual memory tiers. */
export type vramtierid = 'l1' | 'l2' | 'l3' | 'l4';

/** Static description of one virtual memory tier. */
export type vramtier = {
  readonly id: vramtierid;
  readonly label: string;
  readonly source: string;
  readonly capacity: string;
  readonly latencyns: number;
  readonly detail: string;
};

/**
 * TIERS: the consolidated tier model. L1 is system RAM (~100 ns, limited,
 * ephemeral), L2 is GPU VRAM (compute-bound), L3 is storage RAM held by
 * repositories (practically unlimited) and L4 is the external bucket farm
 * (unlimited, quoting the ~50 us r2 edge rung of the ladder).
 */
export const TIERS = {
  l1: {
    id: 'l1',
    label: 'RAM',
    source: 'system',
    capacity: 'limited, ephemeral',
    latencyns: 100,
    detail: 'working set Map plus SharedArrayBuffer ring; zram amplification applies',
  },
  l2: {
    id: 'l2',
    label: 'VRAM',
    source: 'gpu',
    capacity: 'limited, compute-bound',
    latencyns: 500,
    detail: 'the tier the whole VM impersonates; served by float32 VDR blocks',
  },
  l3: {
    id: 'l3',
    label: 'Storage RAM',
    source: 'repositories',
    capacity: 'practically unlimited',
    latencyns: 10000,
    detail: 'sqlite kvstore, npm chunk packages, github artifacts and releases',
  },
  l4: {
    id: 'l4',
    label: 'External buckets',
    source: 'hf, kaggle, terabox, r2, storj',
    capacity: 'unlimited',
    latencyns: 50000,
    detail: 'bucket farm aggregated by rclone into one virtual pool',
  },
} as const satisfies Record<vramtierid, vramtier>;

/** Returns one tier descriptor, throwing for unknown identifiers. */
export function selecttier(id: vramtierid): vramtier {
  const tier: vramtier | undefined = TIERS[id];
  if (tier === undefined) {
    throw new tierserror(
      `unknown vram tier "${id}"; valid tiers: ${Object.keys(TIERS).join(', ')}`,
    );
  }
  return tier;
}

/* ------------------------------------------------------------------ */
/* Section 3: latency ladder and auto-scale by size                    */
/* ------------------------------------------------------------------ */

/** One rung of the storage-to-RAM latency ladder. */
export type latencylevel = {
  readonly kind: 'ram' | 'zram' | 'tmpfs' | 'mmap' | 'sqlite' | 'r2';
  readonly latencyns: number;
  readonly note: string;
};

/**
 * LATENCYLADDER: the honest ordering of every bridge technique, from
 * ~100 ns DRAM through ~500 ns zram pages, ~1 us tmpfs, ~5 us mmap page
 * faults, ~10 us WAL SQLite reads, down to the ~50 us R2 edge best case.
 */
export const LATENCYLADDER: readonly latencylevel[] = [
  { kind: 'ram', latencyns: 100, note: 'DRAM working set, Map or SharedArrayBuffer' },
  { kind: 'zram', latencyns: 500, note: 'compressed block device in RAM as swap (zstd/lz4, 2-3x)' },
  { kind: 'tmpfs', latencyns: 1000, note: 'ramdisk, ~10x faster than SSD, half of RAM by default' },
  {
    kind: 'mmap',
    latencyns: 5000,
    note: 'file mapped into virtual memory: storage and RAM at once',
  },
  { kind: 'sqlite', latencyns: 10000, note: 'WAL DatabaseSync kvstore read' },
  { kind: 'r2', latencyns: 50000, note: 'edge cache best case; remote reality is 50-300 ms' },
] as const satisfies readonly latencylevel[];

/** Returns the latency of one ladder rung, throwing for unknown kinds. */
export function latencyfor(kind: latencylevel['kind']): number {
  const rung = LATENCYLADDER.find((level) => level.kind === kind);
  if (rung === undefined) {
    throw new tierserror(`unknown latency kind "${kind}"`);
  }
  return rung.latencyns;
}

/** Placement strategy recommended by the auto-scale rule. */
export type autoscalestrategy = 'memfs' | 'mmap' | 'sqlite' | 'r2';

/** Outcome of the auto-scale by size rule. */
export type autoscaleresult = {
  readonly strategy: autoscalestrategy;
  readonly tier: vramtierid;
  readonly latencyns: number;
  readonly rationale: string;
};

/**
 * autoscalebysize applies the canonical sizing rule: below 64 MB the
 * block lives in memfs (L1), below 1 GB it rides the mmap bridge (L1 with
 * file backing) and anything larger goes to the SQLite kvstore (L3) or to
 * R2 (L4) when the remote hint is set.
 */
export function autoscalebysize(bytes: number, hint?: 'local' | 'remote'): autoscaleresult {
  return guard('autoscale', 'autoscalebysize', () => {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new tierserror(`bytes must be a non-negative number, received ${bytes}`);
    }
    if (bytes < 64 * 1024 * 1024) {
      return {
        strategy: 'memfs',
        tier: 'l1',
        latencyns: latencyfor('ram'),
        rationale: `${bytes} bytes < 64 MB: memfs keeps the block in the working set`,
      };
    }
    if (bytes < 1024 * 1024 * 1024) {
      return {
        strategy: 'mmap',
        tier: 'l1',
        latencyns: latencyfor('mmap'),
        rationale: `${bytes} bytes < 1 GB: the mmap bridge files the block without copying`,
      };
    }
    return hint === 'remote'
      ? {
          strategy: 'r2',
          tier: 'l4',
          latencyns: latencyfor('r2'),
          rationale: `${bytes} bytes with the remote hint: R2 chunks at the bucket farm`,
        }
      : {
          strategy: 'sqlite',
          tier: 'l3',
          latencyns: latencyfor('sqlite'),
          rationale: `${bytes} bytes >= 1 GB: the WAL kvstore pages the block on demand`,
        };
  });
}

/* ------------------------------------------------------------------ */
/* Section 4: free pool catalog (physical memory of others)            */
/* ------------------------------------------------------------------ */

/** One account family of the free infrastructure pool. */
export type freepoolentry = {
  readonly backend: string;
  readonly quota: string;
  readonly gb: number | null;
  readonly source: string;
};

/** Citation of the free pool table (saddle docs). */
export const FREEPOOLSOURCE =
  'saddle docs readme1.md lines 505-519 (free infrastructure pool and quotas), lines 474-492 (storage backends)';

/**
 * FREEPOOL: the real quota table of the only physical memory the doctrine
 * allows. The counted families sum to 33029.5 GB (~33 TB) before the
 * uncountable npm CDN farm joins, hence the ">33 TB" headline.
 */
export const FREEPOOL: readonly freepoolentry[] = [
  {
    backend: 'github',
    quota: '500 MB artifacts + 10 GB actions cache (7-90 d), 2000 min/mo',
    gb: 10.5,
    source: FREEPOOLSOURCE,
  },
  {
    backend: 'huggingface',
    quota: '~10 TB free best-effort (10 TB public + 1 TB private PRO, Xet 500 GB/file)',
    gb: 10000,
    source: FREEPOOLSOURCE,
  },
  {
    backend: 'kaggle',
    quota: '20 TB public datasets (200 GB/dataset, 50 top-level files, free CDN egress)',
    gb: 20000,
    source: FREEPOOLSOURCE,
  },
  {
    backend: 'terabox',
    quota: '3 TB over three 1 TB accounts (4 GB/file free, 300 files/transfer)',
    gb: 3000,
    source: FREEPOOLSOURCE,
  },
  {
    backend: 'npm',
    quota: '~unlimited: 250 MB tarball/version served verbatim by three CDNs',
    gb: null,
    source: FREEPOOLSOURCE,
  },
  {
    backend: 'r2',
    quota: '10 GB free, 10 M ops/mo, egress free, 5 GB per file',
    gb: 10,
    source: FREEPOOLSOURCE,
  },
  {
    backend: 'turso',
    quota: '9 GB free SQL (500 databases, 500 M rows)',
    gb: 9,
    source: FREEPOOLSOURCE,
  },
] as const satisfies readonly freepoolentry[];

/** Sums the counted families and returns the headline plus npm on top. */
export function freepooltotalgb(): { countedgb: number; headline: string } {
  return guard('freepool', 'freepooltotalgb', () => {
    let counted = 0;
    for (const entry of FREEPOOL) {
      if (entry.gb !== null) {
        counted += entry.gb;
      }
    }
    return {
      countedgb: counted,
      headline: `>${(counted / 1000).toFixed(0)} TB counted (${counted} GB) plus the unlimited npm CDN farm`,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 5: sqlitekv (real L3, node:sqlite DatabaseSync)             */
/* ------------------------------------------------------------------ */

/** Live statistics of the kvstore database. */
export type kvstats = {
  readonly keys: number;
  readonly bytes: number;
  readonly path: string;
  readonly journalmode: string;
  readonly oldestaccess: number | null;
};

/**
 * sqlitekv is the real L3 local backend: a node:sqlite DatabaseSync file
 * opened in the tmpdir by default (SADDLE_TIERS_DB overrides the path)
 * with the canonical RAM pragmas (WAL, synchronous=NORMAL,
 * cache_size=10000, temp_store=MEMORY) and the kvstore table of the
 * docs. Reads touch the LRU column through UPDATE ... SET accessedat =
 * strftime ... RETURNING value, lruvacuate evicts oldest-first until the
 * budget fits, and the class is Disposable for `using` declarations.
 */
export class sqlitekv implements Disposable {
  /** Absolute path of the database file. */
  readonly path: string;

  #db: DatabaseSync;
  #closed = false;
  #getstmt: StatementSync | null = null;
  #setstmt: StatementSync | null = null;
  #delstmt: StatementSync | null = null;

  constructor(path?: string) {
    this.path = path ?? process.env.SADDLE_TIERS_DB ?? join(tmpdir(), 'saddle-tiers.db');
    this.#db = guard('sqlitekv', `sqlitekv open ${this.path}`, () => {
      const db = new DatabaseSync(this.path);
      db.exec(
        'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; ' +
          'PRAGMA cache_size = 10000; PRAGMA temp_store = MEMORY;',
      );
      db.exec(
        'CREATE TABLE IF NOT EXISTS kvstore (key TEXT PRIMARY KEY, value BLOB NOT NULL, ' +
          'createdat INTEGER NOT NULL, accessedat INTEGER NOT NULL); ' +
          'CREATE INDEX IF NOT EXISTS kvstore_lru ON kvstore(accessedat, createdat);',
      );
      return db;
    });
  }

  /** True once Symbol.dispose has closed the handle. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Reads one key while touching the LRU clock in the same statement. */
  get(key: string): Buffer | null {
    return guard('sqlitekv', `sqlitekv.get(${key})`, () => {
      this.#assertopen();
      if (typeof key !== 'string' || key.length === 0 || key.length > 512) {
        throw new tierserror(`invalid kvstore key length ${key?.length ?? 0}`);
      }
      this.#getstmt ??= this.#db.prepare(
        "UPDATE kvstore SET accessedat = CAST(strftime('%s','now') AS INTEGER) " +
          'WHERE key = ? RETURNING value',
      );
      const row = this.#getstmt.get(key) as { value: Uint8Array } | undefined;
      return row === undefined ? null : Buffer.from(row.value);
    });
  }

  /** Upserts one key with a fresh LRU clock, keeping the original createdat. */
  set(key: string, value: Buffer): void {
    guard('sqlitekv', `sqlitekv.set(${key})`, () => {
      this.#assertopen();
      if (typeof key !== 'string' || key.length === 0 || key.length > 512) {
        throw new tierserror(`invalid kvstore key length ${key?.length ?? 0}`);
      }
      if (!Buffer.isBuffer(value)) {
        throw new tierserror('sqlitekv.set expects a Buffer value');
      }
      this.#setstmt ??= this.#db.prepare(
        'INSERT INTO kvstore (key, value, createdat, accessedat) VALUES (?, ?, ' +
          "CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, accessedat = excluded.accessedat',
      );
      this.#setstmt.run(key, value);
    });
  }

  /** Deletes one key, returning true when a row was removed. */
  delete(key: string): boolean {
    return guard('sqlitekv', `sqlitekv.delete(${key})`, () => {
      this.#assertopen();
      this.#delstmt ??= this.#db.prepare('DELETE FROM kvstore WHERE key = ?');
      return this.#delstmt.run(key).changes > 0;
    });
  }

  /** Lists keys, optionally filtered by prefix (page table reloads). */
  keys(prefix?: string): string[] {
    return guard('sqlitekv', 'sqlitekv.keys', () => {
      this.#assertopen();
      const rows = (
        prefix === undefined
          ? this.#db.prepare('SELECT key FROM kvstore ORDER BY key').all()
          : this.#db
              .prepare('SELECT key FROM kvstore WHERE key LIKE ? ESCAPE "\\" ORDER BY key')
              .all(`${prefix.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
      ) as { key: string }[];
      return rows.map((row) => row.key);
    });
  }

  /**
   * Evicts least recently used rows until the stored bytes fit the budget,
   * returning the evicted count; accessedat orders, createdat breaks ties.
   */
  lruvacuate(tobytes: number): number {
    return guard('sqlitekv', 'sqlitekv.lruvacuate', () => {
      this.#assertopen();
      if (!Number.isFinite(tobytes) || tobytes < 0) {
        throw new tierserror(`tobytes must be non-negative, received ${tobytes}`);
      }
      let evicted = 0;
      for (;;) {
        const totals = this.#db
          .prepare('SELECT TOTAL(LENGTH(value)) AS bytes FROM kvstore')
          .get() as {
          bytes: number | null;
        };
        if (totals.bytes === null || totals.bytes <= tobytes) {
          return evicted;
        }
        const oldest = this.#db
          .prepare('SELECT key FROM kvstore ORDER BY accessedat, createdat, key LIMIT 1')
          .get() as { key: string } | undefined;
        if (oldest === undefined) {
          return evicted;
        }
        this.#db.prepare('DELETE FROM kvstore WHERE key = ?').run(oldest.key);
        evicted += 1;
      }
    });
  }

  /** Returns the live statistics of the database. */
  stats(): kvstats {
    return guard('sqlitekv', 'sqlitekv.stats', () => {
      this.#assertopen();
      const counts = this.#db.prepare('SELECT COUNT(*) AS keys FROM kvstore').get() as {
        keys: number;
      };
      const sizes = this.#db.prepare('SELECT TOTAL(LENGTH(value)) AS bytes FROM kvstore').get() as {
        bytes: number | null;
      };
      const journal = this.#db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      const oldest = this.#db
        .prepare('SELECT MIN(accessedat) AS oldestaccess FROM kvstore')
        .get() as { oldestaccess: number | null };
      return {
        keys: counts.keys,
        bytes: Math.round(sizes.bytes ?? 0),
        path: this.path,
        journalmode: journal.journal_mode,
        oldestaccess: oldest.oldestaccess,
      };
    });
  }

  /** Closes the database handle (Disposable for `using` declarations). */
  [Symbol.dispose](): void {
    guard('sqlitekv', 'sqlitekv dispose', () => {
      if (!this.#closed) {
        this.#db.close();
        this.#closed = true;
      }
    });
  }

  #assertopen(): void {
    if (this.#closed) {
      throw new tierserror('sqlitekv is closed');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Section 6: storage backend contract and the L1 ram backend          */
/* ------------------------------------------------------------------ */

/**
 * storagebackend is the contract every tier implements: an ordered id,
 * the tier it serves, its ladder latency, a planner flag marking the
 * backends that only plan IO (no token configured) and async
 * get/set/delete so a REST call and a WAL statement share one shape.
 */
export interface storagebackend {
  readonly id: string;
  readonly tier: vramtierid;
  readonly label: string;
  readonly latencyns: number;
  readonly planner: boolean;
  get(key: string): Promise<Buffer | null>;
  set(key: string, buffer: Buffer): Promise<void>;
  delete(key: string): Promise<boolean>;
  readonly bytes?: () => number;
}

/**
 * rambufferbackend is the L1 working set: a Map of keys to Buffers with
 * an insertion-order LRU ceiling; the oldest entry drops when the ceiling
 * is exceeded (the L3 backends still hold the bytes, so the drop is a
 * demotion in disguise, not a loss).
 */
export class rambufferbackend implements storagebackend {
  readonly id = 'ram';
  readonly tier = 'l1' as const;
  readonly label = 'l1 ram working set (Map)';
  readonly latencyns = 100;
  readonly planner = false;

  #slots = new Map<string, Buffer>();
  #maxbytes: number;

  constructor(options?: { readonly maxbytes?: number }) {
    this.#maxbytes = options?.maxbytes ?? 64 * 1024 * 1024;
  }

  /** Maximum bytes kept in the working set. */
  get maxbytes(): number {
    return this.#maxbytes;
  }

  async get(key: string): Promise<Buffer | null> {
    return guard('ram', `rambufferbackend.get(${key})`, () => {
      const hit = this.#slots.get(key) ?? null;
      if (hit !== null) {
        this.#slots.delete(key);
        this.#slots.set(key, hit);
      }
      return hit;
    });
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    guard('ram', `rambufferbackend.set(${key})`, () => {
      this.#slots.delete(key);
      this.#slots.set(key, buffer);
      while (this.bytes() > this.#maxbytes && this.#slots.size > 1) {
        const oldest = this.#slots.keys().next();
        if (oldest.done === true) {
          break;
        }
        this.#slots.delete(oldest.value);
      }
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.#slots.delete(key);
  }

  /** Bytes currently held by the working set. */
  bytes(): number {
    let total = 0;
    for (const buffer of this.#slots.values()) {
      total += buffer.byteLength;
    }
    return total;
  }
}

/* ------------------------------------------------------------------ */
/* Section 7: sqlite L3 backend                                        */
/* ------------------------------------------------------------------ */

/**
 * sqlitel3backend adapts sqlitekv to the storagebackend contract: the L3
 * storage ram of the ladder at ~10 us per read. It owns the kv handle it
 * creates and closes it on dispose; a borrowed handle stays open.
 */
export class sqlitel3backend implements storagebackend, Disposable {
  readonly id = 'sqlite';
  readonly tier = 'l3' as const;
  readonly label = 'l3 storage ram (node:sqlite WAL kvstore)';
  readonly latencyns = 10000;
  readonly planner = false;

  #kv: sqlitekv;
  #owned: boolean;

  constructor(options?: { readonly kv?: sqlitekv; readonly path?: string }) {
    if (options?.kv !== undefined) {
      this.#kv = options.kv;
      this.#owned = false;
    } else {
      this.#kv = new sqlitekv(options?.path);
      this.#owned = true;
    }
  }

  /** The kv handle behind this backend. */
  get kv(): sqlitekv {
    return this.#kv;
  }

  async get(key: string): Promise<Buffer | null> {
    return this.#kv.get(key);
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    this.#kv.set(key, buffer);
  }

  async delete(key: string): Promise<boolean> {
    return this.#kv.delete(key);
  }

  /** Bytes stored in the kv table. */
  bytes(): number {
    return this.#kv.stats().bytes;
  }

  /** Live statistics passthrough. */
  stats(): kvstats {
    return this.#kv.stats();
  }

  /** Closes the kv handle when this backend owns it. */
  [Symbol.dispose](): void {
    if (this.#owned) {
      this.#kv[Symbol.dispose]();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Section 8: minimal zip codec (crc32, zipbuild, zipread)             */
/* ------------------------------------------------------------------ */

const CRC32TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, polynomial 0xedb88320) of a byte payload. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC32TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** One file inside a zip archive. */
export type zipentry = { readonly name: string; readonly data: Buffer };

/**
 * zipbuild assembles a real zip archive in memory with deflate payloads
 * from node:zlib: local file headers (PK 03 04), one central directory
 * entry per file (PK 01 02) and the end of central directory record (PK
 * 05 06). GitHub artifacts are zip envelopes, so the GitHub backend
 * ships this writer instead of shelling out.
 */
export function zipbuild(entries: readonly zipentry[]): Buffer {
  return guard('zip', 'zipbuild', () => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
      const namebuf = Buffer.from(entry.name, 'utf8');
      const checksum = crc32(entry.data);
      const deflated = deflateRawSync(entry.data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(0x21, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(deflated.length, 18);
      local.writeUInt32LE(entry.data.length, 22);
      local.writeUInt16LE(namebuf.length, 26);
      locals.push(local, namebuf, deflated);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(8, 10);
      central.writeUInt16LE(0x21, 14);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(deflated.length, 20);
      central.writeUInt32LE(entry.data.length, 24);
      central.writeUInt16LE(namebuf.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, namebuf);
      offset += 30 + namebuf.length + deflated.length;
    }
    const centraldir = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centraldir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centraldir, eocd]);
  });
}

/**
 * zipread parses an archive from any zip writer: it scans the end of
 * central directory record, walks the central directory, re-reads each
 * local header for the true extra field length and inflates the payload
 * with inflateRawSync.
 */
export function zipread(archive: Buffer): zipentry[] {
  return guard('zip', 'zipread', () => {
    if (archive.length < 22) {
      throw new tierserror('archive is shorter than the end of central directory record');
    }
    let eocd = -1;
    for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i -= 1) {
      if (archive.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw new tierserror('end of central directory signature not found');
    }
    const count = archive.readUInt16LE(eocd + 10);
    let cursor = archive.readUInt32LE(eocd + 16);
    const entries: zipentry[] = [];
    for (let i = 0; i < count; i += 1) {
      if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
        throw new tierserror(`corrupt central directory entry ${i}`);
      }
      const method = archive.readUInt16LE(cursor + 10);
      const compsize = archive.readUInt32LE(cursor + 20);
      const namelen = archive.readUInt16LE(cursor + 28);
      const trail = archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
      const localoffset = archive.readUInt32LE(cursor + 42);
      const name = archive.subarray(cursor + 46, cursor + 46 + namelen).toString('utf8');
      if (archive.readUInt32LE(localoffset) !== 0x04034b50) {
        throw new tierserror(`corrupt local header for ${name}`);
      }
      const datastart =
        localoffset +
        30 +
        archive.readUInt16LE(localoffset + 26) +
        archive.readUInt16LE(localoffset + 28);
      const stored = archive.subarray(datastart, datastart + compsize);
      const data =
        method === 0 ? Buffer.from(stored) : method === 8 ? inflateRawSync(stored) : null;
      if (data === null) {
        throw new tierserror(`unsupported compression method ${method} for ${name}`);
      }
      entries.push({ name, data });
      cursor += 46 + namelen + trail;
    }
    return entries;
  });
}

/* ------------------------------------------------------------------ */
/* Section 9: npm chunk planner (npm as physical storage)              */
/* ------------------------------------------------------------------ */

/** Default chunk size: 200 MB, the saddle split benchmark. */
export const NPMCHUNKBYTES = 200 * 1024 * 1024;

/**
 * The honest constant of the npm farm: the payload travels as
 * dist/chunk-NNN.bin.js inside one package per chunk because the .bin.js
 * suffix lets binary bytes pass the npm tarball scan while jsDelivr,
 * UNPKG and esm.run serve the file verbatim from their CDNs.
 */
export const NPMCHUNKNOTE =
  'content ships as dist/chunk-NNN.bin.js: the .bin.js suffix escapes the npm binary scan; ' +
  'jsDelivr/UNPKG/esm.run serve the bytes verbatim (100 MB cap per jsDelivr npm file, ' +
  '250 MB tarball per version, so 200 MB chunks ride one package each)';

/** One planned chunk: one npm package carrying one .bin.js file. */
export type npmchunkplan = {
  readonly index: number;
  readonly packagename: string;
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly cdnurls: readonly string[];
};

/** The full layout planned for one payload. */
export type npmchunklayout = {
  readonly scope: string;
  readonly version: string;
  readonly chunkbytes: number;
  readonly totalbytes: number;
  readonly chunks: readonly npmchunkplan[];
  readonly note: string;
};

/** Options of the chunk planner. */
export type npmchunkoptions = {
  readonly scope?: string;
  readonly chunkbytes?: number;
  readonly version?: string;
};

function sha256hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sanitizescope(scope: string): string {
  const clean = scope.replace(/^@+/, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean) || clean.length > 64) {
    throw new tierserror(`invalid npm scope "${scope}"`);
  }
  return clean;
}

/**
 * plannpmchunks splits one payload into the @scope/assets-NNN package
 * series at 200 MB by default: each chunk gets its dist/chunk-NNN.bin.js
 * filename, its real sha256 checksum and the three CDN URLs (jsDelivr,
 * UNPKG, esm.run) that serve it without any npm install. A 300 MB buffer
 * yields two chunks (200 MB + 100 MB), the canonical split of the docs.
 */
export function plannpmchunks(
  buffer: Buffer | Uint8Array,
  options?: npmchunkoptions,
): npmchunklayout {
  return guard('npmchunks', 'plannpmchunks', () => {
    const scope = sanitizescope(options?.scope ?? 'saddle');
    const chunkbytes = options?.chunkbytes ?? NPMCHUNKBYTES;
    const version = options?.version ?? '1.0.0';
    if (!Number.isFinite(chunkbytes) || chunkbytes < 1) {
      throw new tierserror(`chunkbytes must be positive, received ${chunkbytes}`);
    }
    if (!/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/.test(version)) {
      throw new tierserror(`invalid semver "${version}"`);
    }
    const chunks: npmchunkplan[] = [];
    const total = buffer.byteLength;
    for (let start = 0, index = 0; start < total || index === 0; start += chunkbytes, index += 1) {
      const slice = buffer.subarray(start, Math.min(start + chunkbytes, total));
      const tag = String(index + 1).padStart(3, '0');
      const packagename = `@${scope}/assets-${tag}`;
      const filename = `dist/chunk-${tag}.bin.js`;
      chunks.push({
        index,
        packagename,
        filename,
        bytes: slice.byteLength,
        sha256: sha256hex(slice),
        cdnurls: [
          `https://cdn.jsdelivr.net/npm/${packagename}@${version}/${filename}`,
          `https://unpkg.com/${packagename}@${version}/${filename}`,
          `https://esm.run/${packagename}@${version}/${filename}`,
        ],
      });
      if (start + chunkbytes >= total) {
        break;
      }
    }
    return { scope, version, chunkbytes, totalbytes: total, chunks, note: NPMCHUNKNOTE };
  });
}

/** Reassembly plan: fetch every chunk, verify every sha256, concatenate. */
export type reassemblyplan = {
  readonly steps: readonly string[];
  readonly verify: readonly string[];
  readonly manifest: readonly { readonly url: string; readonly sha256: string }[];
  readonly expectedbytes: number;
};

/**
 * reassembleplan turns a layout into the executable reconstruction
 * script: one curl per CDN URL, one sha256 verification per chunk and the
 * final cat that rebuilds the original bytes in order.
 */
export function reassembleplan(layout: npmchunklayout): reassemblyplan {
  return guard('npmchunks', 'reassembleplan', () => {
    const steps: string[] = [];
    const verify: string[] = [];
    const manifest: { url: string; sha256: string }[] = [];
    for (const chunk of layout.chunks) {
      const local = chunk.filename.split('/').pop() as string;
      steps.push(`curl -fsSL "${chunk.cdnurls[0]}" -o "${local}"`);
      verify.push(`echo "${chunk.sha256}  ${local}" | sha256sum -c -`);
      manifest.push({ url: chunk.cdnurls[0], sha256: chunk.sha256 });
    }
    steps.push(
      `cat ${layout.chunks.map((chunk) => chunk.filename.split('/').pop()).join(' ')} > payload-reassembled.bin`,
    );
    return { steps, verify, manifest, expectedbytes: layout.totalbytes };
  });
}

/** Publish plan: real npm CLI commands per chunk package. */
export type publishplan = {
  readonly perchunk: readonly {
    readonly packagename: string;
    readonly commands: readonly string[];
  }[];
  readonly unpublish: readonly string[];
  readonly note: string;
};

/**
 * publishplan emits the real publish sequence per chunk: package.json,
 * payload copy into dist/, `npm publish --access public`, and optionally
 * `npm unpublish` after the flush to a durable tier, exactly like the
 * VDR npm-ephemeral fabric describes.
 */
export function publishplan(
  layout: npmchunklayout,
  options?: { readonly unpublishafterflush?: boolean },
): publishplan {
  return guard('npmchunks', 'publishplan', () => {
    const perchunk = layout.chunks.map((chunk) => {
      const dir = chunk.packagename.split('/')[1];
      return {
        packagename: chunk.packagename,
        commands: [
          `mkdir -p ${dir}/dist`,
          `printf '{"name":"${chunk.packagename}","version":"${layout.version}","description":"storage chunk"}' > ${dir}/package.json`,
          `cp ${chunk.filename.split('/').pop()} ${dir}/${chunk.filename}`,
          `cd ${dir} && npm publish --access public`,
        ],
      };
    });
    return {
      perchunk,
      unpublish: options?.unpublishafterflush
        ? layout.chunks.map(
            (chunk) =>
              `npm unpublish ${chunk.packagename}@${layout.version} --force  # after flush`,
          )
        : [],
      note: NPMCHUNKNOTE,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 10: npmchunkregistry (planner backend)                      */
/* ------------------------------------------------------------------ */

/**
 * npmchunkregistry registers payloads as npm chunk layouts: set() plans
 * the @scope/assets-NNN series without touching the network and get() is
 * honest about needing the CDN fetch described by reassembleplan (this
 * backend is a planner, flagged as such), so the engine keeps walking
 * down the ladder instead of faking a hit.
 */
export class npmchunkregistry implements storagebackend {
  readonly id = 'npmchunks';
  readonly tier = 'l3' as const;
  readonly label = 'l3 npm cdn farm (planner: @scope/assets-NNN .bin.js chunks)';
  readonly latencyns = 50000;
  readonly planner = true;

  #scope: string;
  #chunkbytes: number;
  #layouts = new Map<string, npmchunklayout>();

  constructor(options?: { readonly scope?: string; readonly chunkbytes?: number }) {
    this.#scope = sanitizescope(options?.scope ?? 'saddle');
    this.#chunkbytes = options?.chunkbytes ?? NPMCHUNKBYTES;
  }

  async get(key: string): Promise<Buffer | null> {
    // planner backend: retrieval needs the CDN fetch of reassembleplan.
    void key;
    return null;
  }

  async set(key: string, buffer: Buffer): Promise<void> {
    guard('npmchunks', `npmchunkregistry.set(${key})`, () => {
      this.#layouts.set(
        key,
        plannpmchunks(buffer, { scope: this.#scope, chunkbytes: this.#chunkbytes }),
      );
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.#layouts.delete(key);
  }

  /** Bytes counted across registered layouts. */
  bytes(): number {
    let total = 0;
    for (const layout of this.#layouts.values()) {
      total += layout.totalbytes;
    }
    return total;
  }

  /** Returns the planned layout of one key, or null when absent. */
  layout(key: string): npmchunklayout | null {
    return this.#layouts.get(key) ?? null;
  }

  /** Lists every registered key with its chunk count. */
  keys(): readonly { readonly key: string; readonly chunks: number }[] {
    return [...this.#layouts.entries()].map(([key, layout]) => ({
      key,
      chunks: layout.chunks.length,
    }));
  }
}

/* ------------------------------------------------------------------ */
/* Section 11: github backend (artifacts, releases, blob sync)         */
/* ------------------------------------------------------------------ */

/** Planner-mode answer: the exact call that a token would unlock. */
export type plannedcall = {
  readonly planned: true;
  readonly reason: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: number;
};

/** Outcome of an artifact or release upload. */
export type uploadresult =
  | plannedcall
  | { readonly planned: false; readonly status: number; readonly location: string | null };

/** Options of the GitHub backend. */
export type githuboptions = {
  readonly owner: string;
  readonly repo: string;
  readonly token?: string;
};

/** A downloaded contents blob with its ETag and SHA (for If-Match logic). */
export type githubblob = {
  readonly content: Buffer;
  readonly sha: string;
  readonly etag: string | null;
};

/**
 * githubstorage is the REST client for the only physical memory the
 * doctrine allows: GitHub artifacts (zip envelopes from the local codec,
 * POSTed with a correct multipart boundary), release assets on
 * uploads.github.com (2 GiB per file, enforced locally before the wire)
 * and the contents API as the page-table sync (GET to read, PUT with the
 * sha of the previous revision: the honest If-Match equivalent). Without
 * SADDLE_GITHUB_TOKEN every call degrades to planner mode and returns the
 * exact request it would have sent. The public REST surface documents
 * list/get/delete plus the zip download redirect; the upload path
 * POSTs to /actions/artifacts/{id} as the Actions runtime does.
 */
export class githubstorage implements storagebackend {
  readonly id = 'github';
  readonly tier = 'l3' as const;
  readonly label = 'l3 github artifacts/releases/blobs';
  readonly latencyns = 50000;

  readonly owner: string;
  readonly repo: string;
  #token: string | null;
  #apiversion = '2022-11-28';
  #planned = new Map<string, { readonly bytes: number; readonly url: string }>();

  constructor(options: githuboptions) {
    const parsed = guard('github', 'githubstorage constructor', () => {
      if (!/^[A-Za-z0-9.-]+$/.test(options.owner) || !/^[A-Za-z0-9._-]+$/.test(options.repo)) {
        throw new tierserror(`invalid repository ${options.owner}/${options.repo}`);
      }
      return {
        owner: options.owner,
        repo: options.repo,
        token: options.token ?? process.env.SADDLE_GITHUB_TOKEN ?? null,
      };
    });
    this.owner = parsed.owner;
    this.repo = parsed.repo;
    this.#token = parsed.token;
  }

  /** True when no token is configured and every call plans instead of IO. */
  get planner(): boolean {
    return this.#token === null;
  }

  /**
   * uploadartifact packs the buffer into a zip envelope (one entry per
   * artifact name) and POSTs it to the actions artifacts surface with a
   * correct multipart/form-data boundary; planner mode returns the exact
   * call plus the recorded target.
   */
  async uploadartifact(name: string, buffer: Buffer, artifactid?: number): Promise<uploadresult> {
    return guard('github', `uploadartifact(${name})`, async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        throw new tierserror(`invalid artifact name "${name}"`);
      }
      const zip = zipbuild([{ name: `${name}.bin`, data: buffer }]);
      const target = `/repos/${this.owner}/${this.repo}/actions/artifacts/${artifactid ?? '<artifact-id>'}`;
      const boundary = 'saddletiersartifactboundary';
      const multipart = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="artifact"; filename="${name}.zip"\r\nContent-Type: application/zip\r\n\r\n`,
        ),
        zip,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const headers = this.#headers({
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(multipart.byteLength),
      });
      const url = `https://api.github.com${target}`;
      if (this.#token === null) {
        this.#planned.set(name, { bytes: buffer.byteLength, url: target });
        return {
          planned: true,
          reason: 'SADDLE_GITHUB_TOKEN is not set: the backend stays in planner mode',
          method: 'POST',
          url,
          headers,
          bytes: buffer.byteLength,
        };
      }
      const response = await fetch(url, { method: 'POST', headers, body: multipart });
      return {
        planned: false,
        status: response.status,
        location: response.headers.get('Location'),
      };
    });
  }

  /**
   * downloadartifact follows the documented zip redirect (303 to the
   * signed URL) and unpacks the archive with the local zip codec.
   */
  async downloadartifact(artifactid: number): Promise<zipentry[] | plannedcall> {
    return guard('github', `downloadartifact(${artifactid})`, async () => {
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/actions/artifacts/${artifactid}/zip`;
      if (this.#token === null) {
        return {
          planned: true,
          reason: 'SADDLE_GITHUB_TOKEN is not set: the backend stays in planner mode',
          method: 'GET',
          url,
          headers: this.#headers(),
          bytes: 0,
        };
      }
      const response = await fetch(url, { headers: this.#headers() });
      if (!response.ok) {
        throw new tierserror(`artifact download failed with HTTP ${response.status}`);
      }
      return zipread(Buffer.from(await response.arrayBuffer()));
    });
  }

  /**
   * uploadreleaseasset streams one buffer to uploads.github.com; the
   * 2 GiB per-file limit is enforced locally before the wire.
   */
  async uploadreleaseasset(releaseid: number, name: string, buffer: Buffer): Promise<uploadresult> {
    return guard('github', `uploadreleaseasset(${name})`, async () => {
      if (buffer.byteLength > 2 * 1024 * 1024 * 1024) {
        throw new tierserror(
          `release asset of ${buffer.byteLength} bytes exceeds the 2 GiB per-file limit`,
        );
      }
      const url =
        `https://uploads.github.com/repos/${this.owner}/${this.repo}/releases/${releaseid}/assets` +
        `?name=${encodeURIComponent(name)}`;
      const headers = this.#headers({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buffer.byteLength),
      });
      if (this.#token === null) {
        return {
          planned: true,
          reason: 'SADDLE_GITHUB_TOKEN is not set: the backend stays in planner mode',
          method: 'POST',
          url,
          headers,
          bytes: buffer.byteLength,
        };
      }
      const response = await fetch(url, { method: 'POST', headers, body: buffer });
      return {
        planned: false,
        status: response.status,
        location: response.headers.get('Location'),
      };
    });
  }

  /**
   * getblob reads one repository file through the contents API and hands
   * back the decoded bytes plus the sha and ETag a subsequent PUT needs.
   */
  async getblob(path: string): Promise<githubblob | null> {
    return guard('github', `getblob(${path})`, async () => {
      const url = `${this.#contentsurl(path)}`;
      const response = await fetch(url, { headers: this.#headers() });
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new tierserror(`blob read failed with HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { content?: string; sha?: string };
      if (payload.content === undefined || payload.sha === undefined) {
        throw new tierserror(`blob ${path} returned no content`);
      }
      return {
        content: Buffer.from(payload.content.replace(/\n/g, ''), 'base64'),
        sha: payload.sha,
        etag: response.headers.get('ETag'),
      };
    });
  }

  /**
   * putblob writes one repository file: the sha of the current revision
   * travels in the body and the ETag (when known) rides as the If-Match
   * header, the honest optimistic-concurrency sync behind the VDR page
   * table on GitHub.
   */
  async putblob(
    path: string,
    content: Buffer,
    options?: { readonly sha?: string; readonly message?: string; readonly etag?: string },
  ): Promise<uploadresult> {
    return guard('github', `putblob(${path})`, async () => {
      const url = this.#contentsurl(path);
      const headers = this.#headers({
        'Content-Type': 'application/json',
        ...(options?.etag === undefined ? {} : { 'If-Match': options.etag }),
      });
      const body = JSON.stringify({
        message: options?.message ?? `tiers: sync ${path}`,
        content: content.toString('base64'),
        ...(options?.sha === undefined ? {} : { sha: options.sha }),
      });
      if (this.#token === null) {
        return {
          planned: true,
          reason: 'SADDLE_GITHUB_TOKEN is not set: the backend stays in planner mode',
          method: 'PUT',
          url,
          headers,
          bytes: content.byteLength,
        };
      }
      const response = await fetch(url, { method: 'PUT', headers, body });
      return {
        planned: false,
        status: response.status,
        location: response.headers.get('Location'),
      };
    });
  }

  /** Lists the calls planned so far in planner mode. */
  planneduploads(): readonly {
    readonly key: string;
    readonly bytes: number;
    readonly url: string;
  }[] {
    return [...this.#planned.entries()].map(([key, plan]) => ({ key, ...plan }));
  }

  /** storagebackend surface: reads blobs under tiers/ (live mode only). */
  async get(key: string): Promise<Buffer | null> {
    return guard('github', `githubstorage.get(${key})`, async () => {
      if (this.#token === null) {
        return null;
      }
      const blob = await this.getblob(this.#blobpath(key));
      return blob === null ? null : blob.content;
    });
  }

  /** storagebackend surface: writes blobs with sha conflict handling. */
  async set(key: string, buffer: Buffer): Promise<void> {
    return guard('github', `githubstorage.set(${key})`, async () => {
      const path = this.#blobpath(key);
      if (this.#token === null) {
        this.#planned.set(key, {
          bytes: buffer.byteLength,
          url: `/repos/${this.owner}/${this.repo}/contents/${path}`,
        });
        return;
      }
      const existing = await this.getblob(path);
      const result = await this.putblob(path, buffer, {
        sha: existing?.sha,
        etag: existing?.etag ?? undefined,
      });
      if (!result.planned && result.status >= 300 && result.status !== 200) {
        throw new tierserror(`github blob write failed with HTTP ${result.status}`);
      }
    });
  }

  /** storagebackend surface: deletes blobs through the contents API. */
  async delete(key: string): Promise<boolean> {
    return guard('github', `githubstorage.delete(${key})`, async () => {
      if (this.#token === null) {
        return false;
      }
      const path = this.#blobpath(key);
      const existing = await this.getblob(path);
      if (existing === null) {
        return false;
      }
      const response = await fetch(this.#contentsurl(path), {
        method: 'DELETE',
        headers: this.#headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: `tiers: release ${path}`, sha: existing.sha }),
      });
      return response.ok;
    });
  }

  #contentsurl(path: string): string {
    return `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  }

  #blobpath(key: string): string {
    return `tiers/${encodeURIComponent(key)}.bin`;
  }

  #headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': this.#apiversion,
      'User-Agent': 'saddle-tiers',
      ...extra,
    };
    if (this.#token !== null) {
      headers.Authorization = `Bearer ${this.#token}`;
    }
    return headers;
  }
}

/* ------------------------------------------------------------------ */
/* Section 12: VDR addressing, memoryblock and wire headers            */
/* ------------------------------------------------------------------ */

/** Highest address of the VDR space: 2^64-1. */
export const MAXVDRADDRESS = 0xffffffffffffffffn;

/** The address space in the signed reading of the VDR notes (~9.22 EB). */
export const VDRADDRESSEB = 9.22;

/** Content type of a VDR memory block on the wire. */
export const VDRBLOCKCONTENTTYPE = 'application/vnd.vdr-block+bin';

/** Compression algorithms named by the X-VDR-Compression header. */
export type vdrcompression = 'none' | 'gzip' | 'zstd';

/** formatvdraddress renders 0x-prefixed zero padded hex, the canonical spelling. */
export function formatvdraddress(address: bigint): string {
  validatevdraddress(address);
  return `0x${address.toString(16).padStart(16, '0')}`;
}

/** parsevdraddress accepts 0x hex or decimal text and validates the range. */
export function parsevdraddress(text: string): bigint {
  return guard('vdr', `parsevdraddress(${text})`, () => {
    const trimmed = text.trim().toLowerCase();
    const value = BigInt(trimmed);
    validatevdraddress(value);
    return value;
  });
}

/** validatevdraddress asserts a non-negative 64-bit BigInt. */
export function validatevdraddress(address: bigint): void {
  if (typeof address !== 'bigint' || address < 0n || address > MAXVDRADDRESS) {
    throw new tierserror(
      `vdr address ${String(address)} outside 0x0..0xffffffffffffffff (~${VDRADDRESSEB} EB)`,
    );
  }
}

/**
 * memoryblock is the Prisma-shaped record of the VDR design: a 64-bit
 * address, its length, the optional remote home, the sha256 checksum and
 * the compression flag. Ten GB of RAM and six hundred GB of storage are
 * the same blocks, only the address space differs.
 */
export type memoryblock = {
  readonly address: bigint;
  readonly bytelength: number;
  readonly remoteurl?: string;
  readonly checksum: string;
  readonly iscompressed: boolean;
};

/** Options for the real wire headers of a block. */
export type vdrheadervalues = {
  readonly chunkid: string;
  readonly pointeroffset: number | bigint;
  readonly compression: vdrcompression;
  readonly buffer?: Uint8Array;
  readonly checksum?: string;
};

/**
 * vrdblockheaders generates the real header set of the VDR protocol:
 * Content-Type application/vnd.vdr-block+bin plus X-VDR-Chunk-ID,
 * X-VDR-Pointer-Offset, X-VDR-Compression and X-VDR-Integrity (sha256 of
 * the payload bytes, computed here when a buffer is given or quoted from
 * the stored checksum otherwise). The zstd value is accepted on the wire
 * while this runtime compresses with gzip from node:zlib.
 */
export function vrdblockheaders(values: vdrheadervalues): Record<string, string> {
  return guard('vdr', 'vrdblockheaders', () => {
    const checksum = values.buffer !== undefined ? sha256hex(values.buffer) : values.checksum;
    if (checksum === undefined) {
      throw new tierserror('vrdblockheaders needs a buffer or a stored checksum');
    }
    return {
      'Content-Type': VDRBLOCKCONTENTTYPE,
      'X-VDR-Chunk-ID': values.chunkid,
      'X-VDR-Pointer-Offset': values.pointeroffset.toString(),
      'X-VDR-Compression': values.compression,
      'X-VDR-Integrity': checksum,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 13: page table (interface, local impl, persistence)         */
/* ------------------------------------------------------------------ */

/** The page table contract of the VDR design. */
export interface pagetable {
  readonly backend: string;
  getblock(address: bigint): memoryblock | null;
  setblock(block: memoryblock): void;
  deleteblock(address: bigint): boolean;
  blocks(): readonly memoryblock[];
  size(): number;
}

function blocktojson(block: memoryblock): string {
  return JSON.stringify({
    address: formatvdraddress(block.address),
    bytelength: block.bytelength,
    ...(block.remoteurl === undefined ? {} : { remoteurl: block.remoteurl }),
    checksum: block.checksum,
    iscompressed: block.iscompressed,
  });
}

function blockfromjson(text: string): memoryblock {
  const raw = JSON.parse(text) as {
    address: string;
    bytelength: number;
    remoteurl?: string;
    checksum: string;
    iscompressed: boolean;
  };
  return {
    address: parsevdraddress(raw.address),
    bytelength: raw.bytelength,
    ...(raw.remoteurl === undefined ? {} : { remoteurl: raw.remoteurl }),
    checksum: raw.checksum,
    iscompressed: raw.iscompressed,
  };
}

/**
 * localpagetable keeps blocks in a Map and (when a kv handle is given)
 * persists every record into sqlitekv under the vdr:page: prefix, so the
 * address space survives restarts exactly like the Upstash page table of
 * the design, minus the network.
 */
export class localpagetable implements pagetable {
  readonly backend = 'local map + sqlitekv persistence';

  #blocks = new Map<string, memoryblock>();
  #kv: sqlitekv | null;

  constructor(options?: { readonly kv?: sqlitekv }) {
    this.#kv = options?.kv ?? null;
    const kv = this.#kv;
    guard('pagetable', 'localpagetable constructor', () => {
      if (kv === null) {
        return;
      }
      for (const key of kv.keys('vdr:page:')) {
        const stored = kv.get(key);
        if (stored !== null) {
          this.#blocks.set(key, blockfromjson(stored.toString('utf8')));
        }
      }
    });
  }

  getblock(address: bigint): memoryblock | null {
    return this.#blocks.get(`vdr:page:${formatvdraddress(address)}`) ?? null;
  }

  setblock(block: memoryblock): void {
    guard('pagetable', 'localpagetable.setblock', () => {
      const key = `vdr:page:${formatvdraddress(block.address)}`;
      this.#blocks.set(key, block);
      this.#kv?.set(key, Buffer.from(blocktojson(block), 'utf8'));
    });
  }

  deleteblock(address: bigint): boolean {
    return guard('pagetable', 'localpagetable.deleteblock', () => {
      const key = `vdr:page:${formatvdraddress(address)}`;
      const removed = this.#blocks.delete(key);
      this.#kv?.delete(key);
      return removed;
    });
  }

  blocks(): readonly memoryblock[] {
    return [...this.#blocks.values()];
  }

  size(): number {
    return this.#blocks.size;
  }
}

/* ------------------------------------------------------------------ */
/* Section 14: upstash page table planner                              */
/* ------------------------------------------------------------------ */

/** Plan object for the Upstash Redis REST page table. */
export type upstashplan = {
  readonly resturl: string;
  readonly commands: readonly string[];
  readonly envvars: readonly string[];
  readonly quota: string;
  readonly source: string;
};

/**
 * upstashplanner documents the remote page table of the VDR design as a
 * plan object: the free Upstash Redis REST tier (10k requests/day) with
 * the real GET/SET/DEL commands for the vdr:page: keyspace. No IO is
 * performed; the caller executes the plan when an account exists.
 */
export function upstashplanner(options?: { readonly keyname?: string }): upstashplan {
  return guard('pagetable', 'upstashplanner', () => {
    const keyname = options?.keyname ?? 'vdr:page:0x0000000000000010';
    return {
      resturl: '$UPSTASH_REDIS_REST_URL',
      commands: [
        `curl -fsSL -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" "$UPSTASH_REDIS_REST_URL/get/${keyname}"`,
        `curl -fsSL -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" -X POST "$UPSTASH_REDIS_REST_URL/set" -H "Content-Type: application/json" -d '{"key":"${keyname}","value":"{\\"address\\":\\"0x0000000000000010\\"}"}'`,
        `curl -fsSL -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" "$UPSTASH_REDIS_REST_URL/del/${keyname}"`,
      ],
      envvars: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
      quota: '10,000 requests/day on the free tier (saddle docs readme1.md line 519)',
      source: 'saddle docs readme1.md lines 908 (page table: Upstash Redis) and 519 (quota)',
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 15: vrdringbuffer (L1 SharedArrayBuffer ring)               */
/* ------------------------------------------------------------------ */

/** Flush callback invoked per demoted block when the ceiling is hit. */
export type ringflush = (address: bigint, bytes: Uint8Array) => void;

/** Live statistics of the ring. */
export type ringstats = {
  readonly capbytes: number;
  readonly usedbytes: number;
  readonly liveblocks: number;
  readonly flushcount: number;
  readonly demotedbytes: number;
};

/** Options of the ring buffer. */
export type ringoptions = {
  readonly capbytes?: number;
  readonly capmb?: number;
  readonly onflush?: ringflush;
};

/**
 * vrdringbuffer is the L1 VDRAM: one SharedArrayBuffer with a Float32Array
 * view, 4-byte aligned slots and the auto-flush ceiling of the design
 * (512 MB default, SADDLE_VDR_CAP in MB overrides). When a write no longer
 * fits, every live block is flushed through the onflush callback (the
 * transparent demotion to L3) and the cursor restarts at zero: ring
 * paging at the RAM ceiling, exactly like the VDR notes describe.
 */
export class vrdringbuffer {
  #shared: SharedArrayBuffer;
  #bytes: Uint8Array;
  #floats: Float32Array;
  #capbytes: number;
  #cursor = 0;
  #slots = new Map<bigint, { readonly offset: number; readonly bytelength: number }>();
  #onflush: ringflush | null;
  #flushcount = 0;
  #demotedbytes = 0;

  constructor(options?: ringoptions) {
    const built = guard('ring', 'vrdringbuffer constructor', () => {
      const envcap = Number.parseInt(process.env.SADDLE_VDR_CAP ?? '', 10);
      const capmb = options?.capmb ?? (Number.isFinite(envcap) ? envcap : 512);
      const capbytes = options?.capbytes ?? Math.max(64 * 1024, Math.floor(capmb * 1024 * 1024));
      if (!Number.isFinite(capbytes) || capbytes < 64 * 1024) {
        throw new tierserror('ring capacity must be at least 64 KiB');
      }
      const shared = new SharedArrayBuffer(capbytes);
      return {
        shared,
        bytes: new Uint8Array(shared),
        floats: new Float32Array(shared),
        capbytes,
      };
    });
    this.#shared = built.shared;
    this.#bytes = built.bytes;
    this.#floats = built.floats;
    this.#capbytes = built.capbytes;
    this.#onflush = options?.onflush ?? null;
  }

  /** Ceiling in bytes. */
  get capbytes(): number {
    return this.#capbytes;
  }

  /** Bytes currently live in the ring. */
  get usedbytes(): number {
    return this.#cursor;
  }

  /** Number of full flushes executed at the ceiling. */
  get flushcount(): number {
    return this.#flushcount;
  }

  /** Bytes handed to the demotion callback so far. */
  get demotedbytes(): number {
    return this.#demotedbytes;
  }

  /**
   * writefloats stores one Float32Array payload at a 4-byte aligned slot
   * and reports whether the ceiling forced a full flush first. Payloads
   * larger than the whole ring are rejected (the engine demotes those
   * straight to L3 without paging them).
   */
  writefloats(address: bigint, samples: Float32Array): { readonly flushed: boolean } {
    return guard('ring', 'vrdringbuffer.writefloats', () => {
      validatevdraddress(address);
      if (samples.byteLength === 0 || samples.byteLength % 4 !== 0) {
        throw new tierserror('float payload length must be a positive multiple of 4 bytes');
      }
      if (samples.byteLength > this.#capbytes) {
        throw new tierserror(
          `payload of ${samples.byteLength} bytes exceeds the ring ceiling of ${this.#capbytes} bytes`,
        );
      }
      const flushed = this.#ensurecapacity(samples.byteLength);
      const offset = this.#align4(this.#cursor);
      this.#floats.set(samples, offset / 4);
      this.#slots.set(address, { offset, bytelength: samples.byteLength });
      this.#cursor = offset + samples.byteLength;
      return { flushed };
    });
  }

  /** writebytes stores an opaque byte payload (any alignment). */
  writebytes(address: bigint, payload: Uint8Array): { readonly flushed: boolean } {
    return guard('ring', 'vrdringbuffer.writebytes', () => {
      validatevdraddress(address);
      if (payload.byteLength === 0 || payload.byteLength > this.#capbytes) {
        throw new tierserror(
          `payload of ${payload.byteLength} bytes is empty or exceeds the ring ceiling`,
        );
      }
      const flushed = this.#ensurecapacity(payload.byteLength);
      const offset = this.#align4(this.#cursor);
      this.#bytes.set(payload, offset);
      this.#slots.set(address, { offset, bytelength: payload.byteLength });
      this.#cursor = offset + payload.byteLength;
      return { flushed };
    });
  }

  /** readfloats returns a private copy of one live float payload. */
  readfloats(address: bigint): Float32Array | null {
    return guard('ring', 'vrdringbuffer.readfloats', () => {
      const slot = this.#slots.get(address);
      return slot === undefined
        ? null
        : new Float32Array(this.#shared.slice(slot.offset, slot.offset + slot.bytelength));
    });
  }

  /** readbytes returns a private copy of one live byte payload. */
  readbytes(address: bigint): Uint8Array | null {
    return guard('ring', 'vrdringbuffer.readbytes', () => {
      const slot = this.#slots.get(address);
      return slot === undefined
        ? null
        : this.#bytes.slice(slot.offset, slot.offset + slot.bytelength);
    });
  }

  /** drop removes one address from the ring without demoting it. */
  drop(address: bigint): boolean {
    return this.#slots.delete(address);
  }

  /** Addresses currently live, oldest first. */
  addresses(): readonly bigint[] {
    return [...this.#slots.keys()];
  }

  /** flush demotes every live block now and resets the cursor. */
  flush(): number {
    return guard('ring', 'vrdringbuffer.flush', () => {
      for (const [address, slot] of this.#slots) {
        this.#onflush?.(address, this.#bytes.slice(slot.offset, slot.offset + slot.bytelength));
      }
      this.#demotedbytes += this.#cursor;
      this.#slots.clear();
      this.#cursor = 0;
      this.#flushcount += 1;
      return this.#flushcount;
    });
  }

  /** Live statistics of the ring. */
  stats(): ringstats {
    return {
      capbytes: this.#capbytes,
      usedbytes: this.#cursor,
      liveblocks: this.#slots.size,
      flushcount: this.#flushcount,
      demotedbytes: this.#demotedbytes,
    };
  }

  #ensurecapacity(bytelength: number): boolean {
    const start = this.#align4(this.#cursor);
    if (start + bytelength <= this.#capbytes) {
      return false;
    }
    this.flush();
    return true;
  }

  #align4(value: number): number {
    return value + ((4 - (value % 4)) % 4);
  }
}

/* ------------------------------------------------------------------ */
/* Section 16: universalvdrengine (writevdr/readvdr, L1 to L3 demote)  */
/* ------------------------------------------------------------------ */

/** Options of the universal VDR engine. */
export type vdrengineoptions = {
  readonly capmb?: number;
  readonly pages?: pagetable;
  readonly l3?: storagebackend | null;
};

/** Live statistics of the VDR engine. */
export type vdrstats = {
  readonly capbytes: number;
  readonly usedbytes: number;
  readonly liveblocks: number;
  readonly pagetablesize: number;
  readonly pendingdemes: number;
  readonly demotedblocks: number;
  readonly demotedbytes: number;
};

/**
 * universalvdrengine is the L1-to-L3 pipeline of the VDR design:
 * writevdr lands Float32Array blocks in the SharedArrayBuffer ring (L1,
 * microsecond latency) and registers them in the page table; when the
 * ring hits its ceiling the flush callback queues every live block for
 * demotion into the L3 backend (gzip when the block is compressed).
 * readvdr answers from the ring first and, on a miss, drains the pending
 * demotions, fetches the block from L3, verifies the sha256 checksum of
 * the design and hands back the floats: the demotion is transparent to
 * the caller, which is the entire "everything is VRAM" thesis.
 */
export class universalvdrengine implements Disposable {
  #ring: vrdringbuffer;
  #pages: pagetable;
  #l3: storagebackend | null;
  #pending: { readonly key: string; readonly bytes: Buffer }[] = [];
  #demotedblocks = 0;

  constructor(options?: vdrengineoptions) {
    this.#pages = options?.pages ?? new localpagetable();
    this.#l3 = options?.l3 ?? null;
    const pages = this.#pages;
    const pending = this.#pending;
    this.#ring = guard(
      'vdr',
      'universalvdrengine constructor',
      () =>
        new vrdringbuffer({
          capmb: options?.capmb,
          onflush: (address, bytes) => {
            const block = pages.getblock(address);
            pending.push({
              key: `vdr:${formatvdraddress(address)}`,
              bytes:
                block?.iscompressed === true ? gzipSync(Buffer.from(bytes)) : Buffer.from(bytes),
            });
          },
        }),
    );
  }

  /** Writes one float block at a VDR address and returns its record. */
  writevdr(
    address: bigint,
    samples: Float32Array,
    options?: { readonly compress?: boolean },
  ): memoryblock {
    return guard('vdr', `writevdr(${address})`, () => {
      validatevdraddress(address);
      const bytes = Buffer.from(
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
      );
      const block: memoryblock = {
        address,
        bytelength: bytes.byteLength,
        checksum: sha256hex(bytes),
        iscompressed: options?.compress ?? false,
        ...(this.#l3 === null ? {} : { remoteurl: `tiers://l3/vdr:${formatvdraddress(address)}` }),
      };
      if (bytes.byteLength > this.#ring.capbytes) {
        this.#pending.push({
          key: `vdr:${formatvdraddress(address)}`,
          bytes: options?.compress === true ? gzipSync(bytes) : bytes,
        });
        this.#demotedblocks += 1;
      } else {
        this.#ring.writebytes(address, bytes);
      }
      this.#pages.setblock(block);
      return block;
    });
  }

  /**
   * Reads one address back as floats: the ring answers first; on a miss
   * the pending demotions drain into L3, the block returns from storage,
   * the checksum is verified and the floats are rebuilt. Returns null
   * when the address never existed.
   */
  async readvdr(address: bigint): Promise<Float32Array | null> {
    return guard('vdr', `readvdr(${address})`, async () => {
      validatevdraddress(address);
      const live = this.#ring.readbytes(address);
      if (live !== null) {
        return this.#tofloats(Buffer.from(live));
      }
      const block = this.#pages.getblock(address);
      if (block === null || this.#l3 === null) {
        return null;
      }
      await this.#drain();
      const stored = await this.#l3.get(`vdr:${formatvdraddress(address)}`);
      if (stored === null) {
        return null;
      }
      const plain = block.iscompressed ? gunzipSync(stored) : stored;
      if (sha256hex(plain) !== block.checksum) {
        throw new tierserror(
          `checksum mismatch at ${formatvdraddress(address)}: block integrity violated`,
        );
      }
      return this.#tofloats(plain);
    });
  }

  /**
   * freeramaddress releases one address from every tier: the ring slot,
   * the page table record and the L3 block. Returns true when anything
   * was actually freed.
   */
  async freeramaddress(address: bigint): Promise<boolean> {
    return guard('vdr', `freeramaddress(${address})`, async () => {
      validatevdraddress(address);
      const dropped = this.#ring.drop(address);
      const untracked = this.#pages.deleteblock(address);
      const removed =
        this.#l3 === null ? false : await this.#l3.delete(`vdr:${formatvdraddress(address)}`);
      return dropped || untracked || removed;
    });
  }

  /**
   * blockheaders renders the real wire headers of one address: integrity
   * comes from the live bytes when the block sits in the ring and from
   * the stored checksum after demotion.
   */
  blockheaders(address: bigint): Record<string, string> {
    return guard('vdr', 'blockheaders', () => {
      validatevdraddress(address);
      const block = this.#pages.getblock(address);
      if (block === null) {
        throw new tierserror(`no block mapped at ${formatvdraddress(address)}`);
      }
      const live = this.#ring.readbytes(address);
      return vrdblockheaders({
        chunkid: `vdr-${formatvdraddress(address)}`,
        pointeroffset: 0,
        compression: block.iscompressed ? 'gzip' : 'none',
        ...(live === null ? { checksum: block.checksum } : { buffer: live }),
      });
    });
  }

  /** Page table accessor. */
  get pages(): pagetable {
    return this.#pages;
  }

  /** Ring statistics plus demotion counters. */
  stats(): vdrstats {
    const ring = this.#ring.stats();
    return {
      capbytes: ring.capbytes,
      usedbytes: ring.usedbytes,
      liveblocks: ring.liveblocks,
      pagetablesize: this.#pages.size(),
      pendingdemes: this.#pending.length,
      demotedblocks: this.#demotedblocks,
      demotedbytes: ring.demotedbytes,
    };
  }

  /** Drops the ring without touching L3 (dispose path). */
  [Symbol.dispose](): void {
    this.#pending = [];
    this.#ring.flush();
  }

  async #drain(): Promise<void> {
    if (this.#l3 === null) {
      this.#pending = [];
      return;
    }
    for (const item of this.#pending) {
      await this.#l3.set(item.key, item.bytes);
      this.#demotedblocks += 1;
    }
    this.#pending = [];
  }

  #tofloats(data: Buffer): Float32Array {
    if (data.byteLength % 4 !== 0) {
      throw new tierserror(`block of ${data.byteLength} bytes is not float32 aligned`);
    }
    const view = new Float32Array(data.byteLength / 4);
    view.set(new Float32Array(data.buffer, data.byteOffset, view.length));
    return view;
  }
}

/* ------------------------------------------------------------------ */
/* Section 17: kernel recipes (zram, tmpfs, swap file)                 */
/* ------------------------------------------------------------------ */

/** One printable kernel recipe. */
export type kernelrecipe = {
  readonly kind: 'zram' | 'tmpfs' | 'swapfile';
  readonly commands: readonly string[];
  readonly effect: string;
  readonly source: string;
};

/** Recipe sources of the bridge section. */
export const RECIPESOURCE =
  'saddle docs readme1.md lines 398-421 (storage to RAM bridge mechanics)';

/**
 * zramrecipe plans the compressed RAM swap sequence: modprobe, zstd (or
 * lz4) algorithm, disksize, mkswap, swapon with priority 100. Printable
 * strings only: this module never executes syscalls.
 */
export function zramrecipe(sizegb = 8, algo: 'zstd' | 'lz4' = 'zstd'): kernelrecipe {
  return guard('recipes', 'zramrecipe', () => {
    if (!Number.isFinite(sizegb) || sizegb < 1 || sizegb > 512) {
      throw new tierserror(`sizegb must be between 1 and 512, received ${sizegb}`);
    }
    return {
      kind: 'zram',
      commands: [
        'modprobe zram num_devices=2',
        `echo ${algo} > /sys/block/zram0/comp_algorithm`,
        `echo ${sizegb}G > /sys/block/zram0/disksize`,
        'mkswap /dev/zram0',
        'swapon --priority 100 /dev/zram0',
        'zramctl  # verify: 2-3x amplification at zstd',
      ],
      effect: `${sizegb} GB compressed swap in RAM (~${sizegb * 2}-${sizegb * 3} GB effective at 2:1-3:1)`,
      source: RECIPESOURCE,
    };
  });
}

/** tmpfsrecipe plans a ramdisk mount sized in gigabytes. */
export function tmpfsrecipe(mount = '/mnt/ramdisk', sizegb = 8): kernelrecipe {
  return guard('recipes', 'tmpfsrecipe', () => {
    if (!mount.startsWith('/')) {
      throw new tierserror(`mount point must be absolute, received "${mount}"`);
    }
    if (!Number.isFinite(sizegb) || sizegb < 1) {
      throw new tierserror(`sizegb must be at least 1, received ${sizegb}`);
    }
    return {
      kind: 'tmpfs',
      commands: [`mkdir -p ${mount}`, `mount -t tmpfs -o size=${sizegb}G,mode=1777 tmpfs ${mount}`],
      effect: `${sizegb} GB ramdisk (~10x faster than SSD; /dev/shm already provides half of RAM)`,
      source: RECIPESOURCE,
    };
  });
}

/** swapfilerecipe plans the fallocate/mkswap/swapon swap file sequence. */
export function swapfilerecipe(path = '/mnt/swapfile', sizegb = 16): kernelrecipe {
  return guard('recipes', 'swapfilerecipe', () => {
    if (!path.startsWith('/')) {
      throw new tierserror(`swap path must be absolute, received "${path}"`);
    }
    if (!Number.isFinite(sizegb) || sizegb < 1) {
      throw new tierserror(`sizegb must be at least 1, received ${sizegb}`);
    }
    return {
      kind: 'swapfile',
      commands: [
        `fallocate -l ${sizegb}G ${path}`,
        `chmod 600 ${path}`,
        `mkswap ${path}`,
        `swapon ${path}`,
      ],
      effect: `${sizegb} GB of virtual RAM from disk, the plainest storage-to-RAM bridge`,
      source: RECIPESOURCE,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 18: storagerambridgeplanner (mmap plan objects)             */
/* ------------------------------------------------------------------ */

/** The mmap constants of the StorageRAMBridge API. */
export const MMAPCONSTANTS = {
  PROT_READ: 0x1,
  PROT_WRITE: 0x2,
  MAP_SHARED: 0x01,
  MADV_RANDOM: 1,
} as const satisfies Record<string, number>;

/** One step of the mmap bridge plan: an argv-style operation object. */
export type bridgeplanstep = {
  readonly operation: string;
  readonly args: readonly string[];
  readonly effect: string;
};

/** The full mmap bridge plan. */
export type storagerambridgeplan = {
  readonly storagepath: string;
  readonly ramlimitmb: number;
  readonly syncintervalms: number;
  readonly usesharedmemory: boolean;
  readonly constants: typeof MMAPCONSTANTS;
  readonly seedbytes: number;
  readonly steps: readonly bridgeplanstep[];
  readonly source: string;
};

/**
 * storagerambridgeplanner renders the StorageRAMBridge as plan objects:
 * seed 1 MB with fs.writeFileSync(storagePath, Buffer.alloc(1024*1024)),
 * map with PROT_READ|PROT_WRITE and MAP_SHARED, advise MADV_RANDOM, then
 * read/write by offset, sync with msync, grow with fs.ftruncateSync(fd,
 * newSize) followed by a re-map, and close. Every step is an argv-style
 * record: the module plans, the runner executes.
 */
export function storagerambridgeplanner(
  storagepath: string,
  options?: {
    readonly ramlimitmb?: number;
    readonly syncintervalms?: number;
    readonly usesharedmemory?: boolean;
  },
): storagerambridgeplan {
  return guard('recipes', 'storagerambridgeplanner', () => {
    if (!storagepath.startsWith('/')) {
      throw new tierserror(`storagepath must be absolute, received "${storagepath}"`);
    }
    const syncintervalms = options?.syncintervalms ?? 1000;
    return {
      storagepath,
      ramlimitmb: options?.ramlimitmb ?? 512,
      syncintervalms,
      usesharedmemory: options?.usesharedmemory ?? false,
      constants: MMAPCONSTANTS,
      seedbytes: 1024 * 1024,
      steps: [
        {
          operation: 'fs.writeFileSync',
          args: [storagepath, 'Buffer.alloc(1024 * 1024)'],
          effect: 'seed a 1 MB file so the first map has a page range',
        },
        {
          operation: 'fs.openSync',
          args: [storagepath, "'r+'"],
          effect: 'open the descriptor that backs the mapping',
        },
        {
          operation: 'mmap',
          args: ['null', 'length', 'PROT_READ | PROT_WRITE', 'MAP_SHARED', 'fd', '0'],
          effect: 'map the file into virtual memory: storage and RAM at once',
        },
        {
          operation: 'mmap.advise',
          args: ['buffer', 'MADV_RANDOM'],
          effect: 'random access pattern for kv page reads',
        },
        {
          operation: 'read',
          args: ['offset', 'length'],
          effect: 'zero-copy read straight out of the mapping',
        },
        {
          operation: 'write',
          args: ['offset', 'data'],
          effect: 'writes land in RAM and in the file simultaneously',
        },
        {
          operation: 'sync',
          args: ['msync', String(syncintervalms)],
          effect: `flush dirty pages every ${syncintervalms} ms`,
        },
        {
          operation: 'grow',
          args: ['fs.ftruncateSync(fd, newSize)', 'mmap(null, newSize, ..., MAP_SHARED, fd, 0)'],
          effect: 'extend the file then re-map: capacity grows without a copy',
        },
        {
          operation: 'close',
          args: ['munmap', 'fs.closeSync(fd)'],
          effect: 'unmap and release the descriptor',
        },
      ],
      source: 'saddle docs readme1.md line 426 (StorageRAMBridge API and internals)',
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 19: sysctl drop-in and cgroups v2 slice                     */
/* ------------------------------------------------------------------ */

/**
 * sysctldropin renders the full text of /etc/sysctl.d/99-zai-memory.conf:
 * swappiness 180 (zram-first), zeroed watermark boost, watermark scale
 * 125, page-cluster 0 for swap randomness and overcommit_memory 1 so the
 * address space may exceed the box.
 */
export function sysctldropin(): string {
  return [
    '# /etc/sysctl.d/99-zai-memory.conf',
    '# the memory tuning drop-in of the storage-to-RAM bridge doctrine',
    '# (saddle docs readme1.md line 415)',
    'vm.swappiness = 180',
    'vm.watermark_boost_factor = 0',
    'vm.watermark_scale_factor = 125',
    'vm.page-cluster = 0',
    'vm.overcommit_memory = 1',
    '',
  ].join('\n');
}

/** Resource bounds of one cgroups v2 slice. */
export type slicelimits = {
  readonly rammb?: number;
  readonly cpupercent?: number;
  readonly pids?: number;
  readonly iorbps?: number;
};

/** Rendered cgroups v2 slice. */
export type cgroupslice = {
  readonly dir: string;
  readonly files: readonly { readonly path: string; readonly value: string }[];
  readonly source: string;
};

/**
 * cgroupsv2slice renders the control files of one slice: subtree_control
 * enables memory/cpu/pids/io, memory.max bounds the RAM with memory.high
 * at 90 percent as the throttle line, swap is off, cpu.max carries the
 * percent as quota over the 100 ms period, pids.max caps the tasks,
 * io.max bounds the device bandwidth and memory.oom.group keeps the
 * blast radius inside the slice.
 */
export function cgroupsv2slice(name: string, limits: slicelimits = {}): cgroupslice {
  return guard('recipes', 'cgroupsv2slice', () => {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) {
      throw new tierserror(`invalid slice name "${name}"`);
    }
    const rammb = limits.rammb ?? 2048;
    const cpupercent = limits.cpupercent ?? 400;
    const pids = limits.pids ?? 256;
    const iorbps = limits.iorbps ?? 104857600;
    const dir = `/sys/fs/cgroup/${name}`;
    return {
      dir,
      files: [
        { path: `${dir}/cgroup.subtree_control`, value: '+memory +cpu +pids +io' },
        { path: `${dir}/memory.max`, value: `${rammb}M` },
        { path: `${dir}/memory.high`, value: `${Math.floor(rammb * 0.9)}M` },
        { path: `${dir}/memory.swap.max`, value: '0' },
        { path: `${dir}/memory.oom.group`, value: '1' },
        { path: `${dir}/cpu.max`, value: `${cpupercent * 1000} 100000` },
        { path: `${dir}/pids.max`, value: `${pids}` },
        { path: `${dir}/io.max`, value: `8:0 rbps=${iorbps} wbps=${iorbps}` },
      ],
      source: 'saddle docs readme1.md line 416 (cgroups v2)',
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 20: storage == compute (sniffer, VFS, usage flag)          */
/* ------------------------------------------------------------------ */

/** Magic identities recognized by the sniffer. */
export type magicid = 'elf' | 'pe' | 'png' | 'zip' | 'unknown';

/** The magic byte catalog: true type over file extension. */
export const MAGICBYTES = {
  elf: '7f454c46',
  pe: '4d5a',
  png: '89504e47',
  zip: '504b0304',
} as const satisfies Record<Exclude<magicid, 'unknown'>, string>;

/** Outcome of one sniff. */
export type magicresult = {
  readonly kind: magicid;
  readonly signature: string;
  readonly note: string;
};

/**
 * sniffmagic reads the true type of a payload from its leading bytes:
 * ELF 7F 45 4C 46, PE 4D 5A, PNG 89 50 4E 47 and ZIP 50 4B 03 04, the
 * four signatures of the storage==compute table. The four-byte probes run
 * before the two-byte PE probe so 'MZ' never masks a longer match.
 */
export function sniffmagic(buffer: Uint8Array): magicresult {
  return guard('sniffer', 'sniffmagic', () => {
    const head = Buffer.from(buffer.subarray(0, 4)).toString('hex').padEnd(8, '0');
    for (const kind of ['elf', 'png', 'zip'] as const) {
      if (head.startsWith(MAGICBYTES[kind])) {
        return { kind, signature: MAGICBYTES[kind], note: `magic match on ${kind}` };
      }
    }
    if (head.startsWith(MAGICBYTES.pe)) {
      return { kind: 'pe', signature: MAGICBYTES.pe, note: 'magic match on pe' };
    }
    return { kind: 'unknown', signature: head.slice(0, 8), note: 'no known magic prefix' };
  });
}

/** VFS inode: the storage-side twin of a compute buffer. */
export type vfsinode = {
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly ops: readonly string[];
};

/** VFS dentry: the name that binds an inode into the tree. */
export type vfsdentry = {
  readonly name: string;
  readonly parent: string | null;
  readonly inode: vfsinode;
  readonly usage: 'process' | 'keep';
};

/**
 * virtualfilesystem proves the thesis in code: mountbuffer registers the
 * same bytes under an inode plus dentry exactly once, and the usage flag
 * is the only difference between storage and compute. read hands back
 * the very same Buffer reference (zero copy): the bytes never changed,
 * only the intent did.
 */
export class virtualfilesystem {
  #inodes = new Map<number, { readonly inode: vfsinode; readonly buffer: Buffer }>();
  #dentries = new Map<string, vfsdentry>();
  #nextino = 2;

  /** Mounts one buffer as inode+dentry with the requested usage flag. */
  mountbuffer(path: string, buffer: Buffer, usage: 'process' | 'keep'): vfsdentry {
    return guard('vfs', `mountbuffer(${path})`, () => {
      if (!path.startsWith('/') || path.includes('..')) {
        throw new tierserror(`invalid vfs path "${path}"`);
      }
      const inode: vfsinode = {
        ino: this.#nextino,
        mode: 0o100644,
        size: buffer.byteLength,
        ops: ['read', 'write', 'mmap'],
      };
      this.#nextino += 1;
      this.#inodes.set(inode.ino, { inode, buffer });
      const parts = path.split('/');
      const name = parts.pop() as string;
      const dentry: vfsdentry = {
        name,
        parent: parts.length > 1 ? parts.join('/') : null,
        inode,
        usage,
      };
      this.#dentries.set(path, dentry);
      return dentry;
    });
  }

  /** Reads one path: the same Buffer reference that was mounted. */
  read(path: string): Buffer | null {
    const dentry = this.#dentries.get(path);
    return dentry === undefined ? null : (this.#inodes.get(dentry.inode.ino)?.buffer ?? null);
  }

  /** The usage flag of one path: process or keep, the only difference. */
  usageof(path: string): 'process' | 'keep' | null {
    return this.#dentries.get(path)?.usage ?? null;
  }

  /** Resolves one dentry. */
  resolve(path: string): vfsdentry | null {
    return this.#dentries.get(path) ?? null;
  }

  /** Number of mounted inodes. */
  size(): number {
    return this.#inodes.size;
  }
}

/* ------------------------------------------------------------------ */
/* Section 21: memoryengine (ordered tiers, first hit wins)            */
/* ------------------------------------------------------------------ */

/** A compute buffer: the same bytes flagged for processing. */
export type computebuffer = {
  readonly buffer: Buffer;
  readonly tier: vramtierid;
  readonly latencyns: number;
  readonly backend: string;
  readonly kind: magicid;
  readonly usage: 'process';
};

/** A storage buffer: the same bytes flagged for keeping. */
export type storagebuffer = {
  readonly buffer: Buffer;
  readonly tier: vramtierid;
  readonly latencyns: number;
  readonly backend: string;
  readonly kind: magicid;
  readonly usage: 'keep';
};

/** The result shape of safeload. */
export type safeloadresult =
  | { readonly success: true; readonly data: Buffer }
  | { readonly success: false; readonly error: string };

/** Live engine counters. */
export type enginecounters = {
  readonly loads: number;
  readonly l1hits: number;
  readonly demotions: number;
  readonly persists: number;
  readonly releases: number;
};

/**
 * memoryengine is the facade of the docs: an ordered backend list (the
 * tier ladder incarnate), an L1 Map cache and the load/persist/release
 * triple. load iterates the backends and returns the first hit through
 * transformToCompute (a copy: the documented ~2x overhead, with the
 * magic identity sniffed on the way out); persist writes into every
 * configured backend; release drops the key from the in-memory Map;
 * safeload wraps load in the {success, data, error} envelope. The VFS
 * twin of every loaded buffer is one mountbuffer call away: the same
 * bytes, only the usage flag differs.
 */
export class memoryengine implements Disposable {
  readonly name: string;

  #backends: readonly storagebackend[];
  #cache = new Map<string, Buffer>();
  #vfs = new virtualfilesystem();
  #counters = { loads: 0, l1hits: 0, demotions: 0, persists: 0, releases: 0 };

  constructor(options?: { readonly backends?: readonly storagebackend[]; readonly name?: string }) {
    this.name = options?.name ?? 'saddle tiers engine';
    this.#backends = options?.backends ?? [];
  }

  /** Describes the wired backends in tier order. */
  backends(): readonly {
    readonly id: string;
    readonly tier: vramtierid;
    readonly planner: boolean;
  }[] {
    return this.#backends.map((backend) => ({
      id: backend.id,
      tier: backend.tier,
      planner: backend.planner,
    }));
  }

  /**
   * load returns the first hit across the ladder. The L1 cache answers
   * directly; otherwise every backend is consulted in order, the first
   * hit is cached and returned as a compute buffer. A miss on every tier
   * throws the documented error.
   */
  async load(key: string): Promise<computebuffer> {
    return guard('engine', `load(${key})`, async () => {
      this.#counters.loads += 1;
      const cached = this.#cache.get(key) ?? null;
      if (cached !== null) {
        this.#counters.l1hits += 1;
        return this.transformToCompute(cached, {
          tier: 'l1',
          latencyns: latencyfor('ram'),
          backend: 'cache',
        });
      }
      for (const backend of this.#backends) {
        const hit = await backend.get(key);
        if (hit !== null) {
          this.#cache.set(key, hit);
          if (backend.tier !== 'l1') {
            this.#counters.demotions += 1;
          }
          return this.transformToCompute(hit, {
            tier: backend.tier,
            latencyns: backend.latencyns,
            backend: backend.id,
          });
        }
      }
      throw new tierserror(
        `load("${key}") missed every tier: ${this.#backends.map((b) => b.id).join(', ') || 'no backends'}`,
      );
    });
  }

  /** persist writes the payload into every configured backend. */
  async persist(key: string, data: Buffer): Promise<readonly string[]> {
    return guard('engine', `persist(${key})`, async () => {
      if (!Buffer.isBuffer(data)) {
        throw new tierserror('persist expects a Buffer payload');
      }
      this.#counters.persists += 1;
      this.#cache.set(key, data);
      const written: string[] = [];
      const failures: string[] = [];
      for (const backend of this.#backends) {
        try {
          await backend.set(key, data);
          written.push(backend.id);
        } catch (backenderror) {
          failures.push(`${backend.id}: ${(backenderror as Error).message}`);
        }
      }
      if (written.length === 0 && failures.length > 0) {
        throw new tierserror(`persist("${key}") failed on every backend: ${failures.join('; ')}`);
      }
      return written;
    });
  }

  /** release deletes the key from the in-memory Map, per the docs. */
  release(key: string): boolean {
    this.#counters.releases += 1;
    return this.#cache.delete(key);
  }

  /** safeload wraps load in the {success, data, error} envelope. */
  async safeload(key: string): Promise<safeloadresult> {
    try {
      const loaded = await this.load(key);
      return { success: true, data: loaded.buffer };
    } catch (cause) {
      return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * transformToCompute copies the bytes (the documented ~2x overhead),
   * sniffs the true type from the magic prefix and flags the result for
   * processing: the compute side of the thesis.
   */
  transformToCompute(
    buffer: Buffer,
    meta?: { readonly tier?: vramtierid; readonly latencyns?: number; readonly backend?: string },
  ): computebuffer {
    return guard('engine', 'transformToCompute', () => ({
      buffer: Buffer.from(buffer),
      tier: meta?.tier ?? 'l1',
      latencyns: meta?.latencyns ?? latencyfor('ram'),
      backend: meta?.backend ?? 'cache',
      kind: sniffmagic(buffer).kind,
      usage: 'process',
    }));
  }

  /**
   * transformToStorage keeps the very same Buffer reference (zero copy)
   * and flips the usage flag to keep: the storage side of the thesis. No
   * byte changes, which is the point.
   */
  transformToStorage(
    buffer: Buffer,
    meta?: { readonly tier?: vramtierid; readonly latencyns?: number; readonly backend?: string },
  ): storagebuffer {
    return guard('engine', 'transformToStorage', () => ({
      buffer,
      tier: meta?.tier ?? 'l3',
      latencyns: meta?.latencyns ?? latencyfor('sqlite'),
      backend: meta?.backend ?? 'storage',
      kind: sniffmagic(buffer).kind,
      usage: 'keep',
    }));
  }

  /** Mounts one loaded key into the VFS twin under the requested usage. */
  mount(key: string, usage: 'process' | 'keep'): vfsdentry {
    return guard('engine', `mount(${key})`, () => {
      const cached = this.#cache.get(key);
      if (cached === undefined) {
        throw new tierserror(`mount("${key}") requires a cached buffer (load first)`);
      }
      return this.#vfs.mountbuffer(`/tiers/${key}`, cached, usage);
    });
  }

  /** Live counters of the engine. */
  counters(): enginecounters {
    return { ...this.#counters };
  }

  /** Closes disposable backends (the sqlite kv among them). */
  [Symbol.dispose](): void {
    for (const backend of this.#backends) {
      const disposable = backend as Partial<Disposable>;
      if (typeof disposable[Symbol.dispose] === 'function') {
        try {
          disposable[Symbol.dispose]?.();
        } catch {
          /* catcher: one failing backend must not block the rest */
        }
      }
    }
    this.#cache.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Section 22: creatiersengine factory                                 */
/* ------------------------------------------------------------------ */

/** Configuration of the tiers engine factory. */
export type tiersengineconfig = {
  readonly name?: string;
  readonly ram?: { readonly maxbytes?: number } | true;
  readonly sqlitedb?: string | true;
  readonly npmscope?: string;
  readonly github?: githuboptions;
  readonly vdr?: { readonly capmb?: number } | true;
};

/** The assembled stack returned by the factory. */
export type tiersstack = {
  readonly engine: memoryengine;
  readonly kv: sqlitekv | null;
  readonly sqlite: sqlitel3backend | null;
  readonly npm: npmchunkregistry | null;
  readonly github: githubstorage | null;
  readonly vdr: universalvdrengine | null;
  readonly modes: readonly string[];
};

/**
 * creatiersengine wires the full stack from one config: the L1 ram
 * working set, the L3 sqlite kvstore (default tmpdir, SADDLE_TIERS_DB
 * overrides), the npm chunk planner (planner backend), the GitHub backend
 * (planner without SADDLE_GITHUB_TOKEN, live with it) and, when vdr is
 * requested, the universal VDR engine whose ring demotes into the same
 * sqlite kv and whose page table persists there. The modes array states
 * honestly which backends plan and which execute.
 */
export function creatiersengine(config: tiersengineconfig = {}): tiersstack {
  return guard('factory', 'creatiersengine', () => {
    const kv =
      config.sqlitedb === undefined
        ? null
        : new sqlitekv(config.sqlitedb === true ? undefined : config.sqlitedb);
    const sqlite = kv === null ? null : new sqlitel3backend({ kv });
    const npm =
      config.npmscope === undefined ? null : new npmchunkregistry({ scope: config.npmscope });
    const github = config.github === undefined ? null : new githubstorage(config.github);
    const ram = new rambufferbackend(
      config.ram === true || config.ram === undefined ? {} : config.ram,
    );
    const backends: storagebackend[] = [ram];
    if (sqlite !== null) {
      backends.push(sqlite);
    }
    if (npm !== null) {
      backends.push(npm);
    }
    if (github !== null) {
      backends.push(github);
    }
    const vdr =
      config.vdr === undefined
        ? null
        : new universalvdrengine({
            capmb: config.vdr === true ? undefined : config.vdr.capmb,
            l3: sqlite,
            pages: kv === null ? undefined : new localpagetable({ kv }),
          });
    return {
      engine: new memoryengine({ backends, name: config.name }),
      kv,
      sqlite,
      npm,
      github,
      vdr,
      modes: backends.map(
        (backend) => `${backend.id}: ${backend.planner ? 'planner' : 'live'} (${backend.tier})`,
      ),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Section 23: quotaplanner (hf, kaggle, terabox, r2, forges)          */
/* ------------------------------------------------------------------ */

/** The bucket families planned by the catalog. */
export type catalogkind =
  | 'hf'
  | 'kaggle'
  | 'terabox'
  | 'r2'
  | 'storj'
  | 'gitlab'
  | 'forgejo'
  | 'gitea';

/** One catalog plan: commands, env, quotas and citation, no faked IO. */
export type catalogplan = {
  readonly backend: catalogkind;
  readonly commands: readonly string[];
  readonly envvars: Readonly<Record<string, string>>;
  readonly quotas: readonly string[];
  readonly source: string;
};

/** Options of the catalog planner. */
export type catalogoptions = {
  readonly owner?: string;
  readonly repo?: string;
  readonly repoid?: string;
  readonly workflowid?: string;
  readonly uuid?: string;
};

/**
 * quotaplanner renders the upload/dispatch plan of every L4 family as
 * plan objects: the Hugging Face upload_folder dataset push with the
 * real resolve URL pattern, the Kaggle dataset-metadata.json plus create
 * call, the Terabox rclone serve/sync pair with --transfers 8, the
 * R2/Storj s3 bucket writes and the GitLab/Forgejo/Gitea pipeline
 * dispatch endpoints. Every plan carries the quota table and the saddle
 * citation; nothing is executed here.
 */
export function quotaplanner(kind: catalogkind, options: catalogoptions = {}): catalogplan {
  return guard('catalog', `quotaplanner(${kind})`, (): catalogplan => {
    const owner = options.owner ?? 'opencode';
    const repo = options.repo ?? 'opencode-storage';
    const uuid = options.uuid ?? '00000000-0000-4000-8000-000000000000';
    switch (kind) {
      case 'hf':
        return {
          backend: 'hf',
          commands: [
            `python3 -c "from huggingface_hub import HfApi; import os; HfApi(token=os.environ['HF_TOKEN']).upload_folder(repo_id='${owner}/${repo}', repo_type='dataset', folder_path='results')"`,
            `curl -fsSL "https://huggingface.co/datasets/${owner}/${repo}/resolve/main/payload.bin" -o payload.bin`,
          ],
          envvars: { HF_TOKEN: '<write token>' },
          quotas: [
            'free unlimited best-effort; 10 TB public + 1 TB private PRO',
            '500 GB/file via Xet; private tier 100 GB',
          ],
          source: 'saddle docs readme1.md lines 479 and 486 (hf quota and upload_folder pattern)',
        };
      case 'kaggle':
        return {
          backend: 'kaggle',
          commands: [
            `printf '{"title":"${repo}","id":"${owner}/${repo}","licenses":[{"name":"CC0-1.0"}]}' > dataset-metadata.json`,
            'kaggle datasets create -p results --dir-mode tar',
          ],
          envvars: { KAGGLE_USERNAME: '<username>', KAGGLE_KEY: '<api key>' },
          quotas: [
            '200 GB/dataset, 50 top-level files, free CDN egress',
            'public storage unlimited',
          ],
          source: 'saddle docs readme1.md lines 480 and 486 (kaggle quota and metadata)',
        };
      case 'terabox':
        return {
          backend: 'terabox',
          commands: [
            'rclone serve http terabox1:opencode-storage/ --addr :8080',
            'rclone sync terabox1:opencode-storage huggingface:opencode-storage --transfers 8',
          ],
          envvars: { RCLONE_CONFIG_TERABOX1_TYPE: 'terabox' },
          quotas: ['1 TB/account (3 TB across three), 4 GB/file free', '300 files/transfer'],
          source: 'saddle docs readme1.md lines 477 and 481 (rclone serve/sync, terabox quota)',
        };
      case 'r2':
        return {
          backend: 'r2',
          commands: [
            `rclone copy payload.bin :s3,provider=Cloudflare,endpoint=https://<accountid>.r2.cloudflarestorage.com:opencode-bucket/${uuid}`,
          ],
          envvars: { AWS_ACCESS_KEY_ID: '<r2 key id>', AWS_SECRET_ACCESS_KEY: '<r2 secret>' },
          quotas: ['10 GB free, 10 M ops/mo, egress free', '5 GB per file'],
          source: 'saddle docs readme1.md line 478 (s3/r2 backend)',
        };
      case 'storj':
        return {
          backend: 'storj',
          commands: [`rclone copy payload.bin storj:opencode-bucket/${uuid}`],
          envvars: { STORJ_ACCESS_GRANT: '<access grant>' },
          quotas: ['free S3-compatible decentralized storage', 'egress via the CDN gateway'],
          source: 'saddle docs readme1.md line 488 (storj backend)',
        };
      case 'gitlab':
        return {
          backend: 'gitlab',
          commands: [
            `curl -fsSL -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/${options.repoid ?? '<id>'}/pipeline_schedules" -d '{"description":"tiers flush","ref":"main","cron":"0 */6 * * *"}'`,
            `curl -fsSL -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/${options.repoid ?? '<id>'}/pipeline_schedules/<schedule-id>/play"`,
            `curl -fsSL -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/${options.repoid ?? '<id>'}/trigger/pipeline" -d "ref=main&token=$GITLAB_TRIGGER"`,
          ],
          envvars: { GITLAB_TOKEN: '<pat>', GITLAB_TRIGGER: '<trigger token>' },
          quotas: ['400 compute min/mo', '10 GB storage + 5 GB cache (14 d), artifacts 30 d'],
          source: 'saddle docs readme1.md line 512 (gitlab dispatch and quotas)',
        };
      case 'forgejo':
      case 'gitea': {
        const host = kind === 'forgejo' ? 'https://codeberg.org' : 'https://gitea.com';
        return {
          backend: kind,
          commands: [
            `curl -fsSL -X POST -H "Authorization: token $${kind.toUpperCase()}_TOKEN" -H "Content-Type: application/json" "${host}/api/v1/repos/${owner}/${repo}/actions/workflows/${options.workflowid ?? '<workflow-id>'}/dispatches" -d '{"ref":"main"}'`,
          ],
          envvars: { [`${kind.toUpperCase()}_TOKEN`]: '<api token>' },
          quotas: [
            'codeberg forgejo: 750 MB soft quota + 1.5 GiB LFS/packages',
            'gitea cloud: per-instance limits',
          ],
          source: 'saddle docs readme1.md lines 512 and 898 (forgejo/gitea dispatch endpoints)',
        };
      }
      default:
        throw new tierserror(`unknown catalog kind "${String(kind)}"`);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Section 24: tiersreport (printable summary)                         */
/* ------------------------------------------------------------------ */

/**
 * tiersreport renders the printable summary of the whole layer: the four
 * tiers with latencies, the ladder, the free pool headline with the
 * counted families, the autoscale rule and the VDR address space. The
 * smoke suite prints it verbatim.
 */
export function tiersreport(): string {
  return guard('report', 'tiersreport', () => {
    const pool = freepooltotalgb();
    const lines: string[] = ['saddle tiers: everything is VRAM', ''];
    for (const tier of Object.values(TIERS)) {
      lines.push(
        `${tier.id} ${tier.label.padEnd(14)} ${String(tier.latencyns).padStart(6)} ns  ${tier.capacity}`,
      );
    }
    lines.push('', 'latency ladder:');
    for (const rung of LATENCYLADDER) {
      lines.push(`  ${rung.kind.padEnd(7)} ${String(rung.latencyns).padStart(6)} ns  ${rung.note}`);
    }
    lines.push(
      '',
      `free pool: ${pool.headline}`,
      ...FREEPOOL.map((entry) => `  ${entry.backend.padEnd(12)} ${entry.quota}`),
      '',
      'autoscale: <64 MB memfs, <1 GB mmap, larger sqlite/r2',
      `vdr: 0x0..0xffffffffffffffff (${VDRADDRESSEB} EB), ring cap 512 MB default (SADDLE_VDR_CAP MB)`,
    );
    return lines.join('\n');
  });
}
