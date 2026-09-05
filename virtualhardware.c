/*
 * virtualhardware.c — ld_preload hardware spoofing core for the virtual hardware
 * engine v5 (vhe).
 *
 * the library intercepts the complete libc file-access family and rewrites
 * reads of procfs hardware sources so that unmodified dynamic binaries observe
 * the virtual machine profile instead of the physical host:
 *
 *   /proc/cpuinfo  ->  /etc/virtual/cpuinfo   (EPYC 9965, 192c/384t, zen 5)
 *   /proc/meminfo  ->  /etc/virtual/meminfo   (128 GB default, dynamic mode)
 *   /proc/uptime   ->  /etc/virtual/uptime    (configurable base + real delta)
 *   /proc/loadavg  ->  /etc/virtual/loadavg   (scaled to VHE_CPUS)
 *   /proc/version  ->  /etc/virtual/version   (custom kernel release)
 *
 * technique provenance (all verified 22/08/2026, see worklog task 1-e):
 *   - open/open64/openat/openat64/fopen/fopen64/freopen/freopen64 interception
 *     and the inotify regeneration thread follow the memoverlay design
 *     (github.com/stantheawesomeman/memoverlay).
 *   - the sysinfo() hook with mem_unit normalization and the uname() hook
 *     follow the dolos design (github.com/cdt4/dolos, dolos/hooks.c).
 *   - real symbol resolution always uses dlsym(RTLD_NEXT, ...) per man3 dlsym:
 *     "find the next occurrence of the symbol after the current object".
 *
 * global installation (per dolos): echo /usr/local/lib/libvirtualhardware.so
 * >> /etc/ld.so.preload — the docker image installs it exactly this way.
 * per-process installation: LD_PRELOAD=/usr/local/lib/libvirtualhardware.so prog.
 * setuid binaries ignore ld_preload and /etc/ld.so.preload by design of the
 * dynamic loader, so privileged tools always see the real host.
 *
 * known limitations, documented for operators:
 *   - statically linked binaries and go binaries that issue raw syscalls
 *     bypass the PLT and cannot be interposed (news.ycombinator.com/item?id=19190275,
 *     reddit.com/r/golang/comments/dlhfm7); the seccomp user_notif technique
 *     from rios0rios0/termux-etc-redirect covers those cases and stays a
 *     future extension.
 *   - cpuid instructions and the real core count cannot be virtualized without a
 *     VM; the engine pairs this library with QEMU -cpu EPYC-v5 for that layer.
 *
 * environment variables (all optional, evaluated once at load time):
 *   VHE_ENABLED          0 disables every hook after resolution (default 1)
 *   VHE_CPUINFO          path overriding /etc/virtual/cpuinfo
 *   VHE_MEMINFO          path overriding /etc/virtual/meminfo (implies static
 *                        mode, memoverlay-compatible behavior)
 *   VHE_MEMINFO_MODE     dynamic (default) regenerates the scaled meminfo in a
 *                        private /tmp directory; static reads the file as-is
 *   VHE_TOTALRAM_GB      virtual total ram in GiB (default 128, EPYC-class node)
 *   VHE_CPUS             virtual logical cpu count (default 192, EPYC 9965)
 *   VHE_UPTIME           virtual uptime base in seconds added to the real uptime
 *   VHE_KERNEL_RELEASE   virtual uname release (default "6.18.0-vhe")
 *   VHE_KERNEL_VERSION   virtual uname version string
 *   VHE_SYSNAME          virtual uname sysname (default "Linux")
 *   VHE_MACHINE          virtual uname machine (default "x86_64")
 *   VHE_MEMINFO_REFRESH  dynamic meminfo refresh interval in seconds (default 5)
 *   VHE_DEBUG            1 prints interception decisions to stderr (fd 2 via
 *                        dprintf, never stdio, so no recursion into fopen)
 *
 * build: clang -std=c11 -O3 -march=native -flto -shared -fPIC -pthread -ldl \
 *            virtualhardware.c -o libvirtualhardware.so
 * the dockerfile pins exactly these flags; -march=native matches the per-
 * platform native build of the multi-arch image (amd64 and arm64).
 */

#define _GNU_SOURCE /* O_PATH, RTLD_NEXT, syscall, strdupa, memunit helpers */

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysinfo.h>
#include <sys/types.h>
#include <sys/utsname.h>
#include <poll.h>
#include <unistd.h>

/* ------------------------------------------------------------------------ */
/* compile-time profile defaults, kept in sync with /etc/virtual generation  */
/* ------------------------------------------------------------------------ */

#define VHEETCBASE        "/etc/virtual"
#define VHETMPPREFIX      "/tmp/.vhe"
#define VHEDEFAULTRAMGB   128UL    /* 128 GiB node, matches dockerfile    */
#define VHEDEFAULTCPUS    192U     /* EPYC 9965 logical processors        */
#define VHEDEFAULTRELEASE "6.18.0-vhe"
#define VHEDEFAULTVERSION "#1 SMP VHE PREEMPT_DYNAMIC 2026-08-22"
#define VHEREFRESHSECS    5U
#define VHEGIB            (1UL << 30) /* 1 GiB in bytes                  */
#define VHEKIB            1024UL

/**
 * runtime configuration, resolved exactly once (pthread_once) from the
 * environment and the filesystem. every field keeps a fallback so the
 * library stays inert when the operator provides no /etc/virtual tree.
 */
typedef struct vheconfig {
    const char   *cpuinfopath;  /* resolved cpuinfo override or NULL      */
    const char   *meminfopath;  /* resolved meminfo override or NULL      */
    const char   *uptimepath;   /* resolved uptime override or NULL       */
    const char   *loadavgpath;  /* resolved loadavg override or NULL      */
    const char   *versionpath;  /* resolved version override or NULL      */
    char          scratchdir[128]; /* private dynamic-mode directory      */
    unsigned long totalrambytes;/* VHE_TOTALRAM_GB << 30                  */
    unsigned long cpus;          /* VHE_CPUS                               */
    unsigned long uptimebase;   /* VHE_UPTIME                             */
    unsigned      refreshsecs;  /* VHE_MEMINFO_REFRESH                    */
    const char   *release;       /* uname release                          */
    const char   *version;       /* uname version                          */
    const char   *sysname;       /* uname sysname                          */
    const char   *machine;       /* uname machine                          */
    int           dynamicmem;   /* 1 = regenerate meminfo via inotify     */
    int           debug;         /* VHE_DEBUG                              */
    int           enabled;       /* VHE_ENABLED                            */
} vheconfig;

static vheconfig       vhecfg;
static pthread_once_t   vheonce = PTHREAD_ONCE_INIT;
static volatile int     vhestop;          /* watched by the reaper thread  */
static pthread_t        vhewatcherthread;

/**
 * thread-local reentrancy guard. the library itself opens files (regenerating
 * the scaled meminfo, logging); those internal calls must reach the real libc
 * symbols or the hooks would recurse forever. memoverlay uses the same pattern.
 */
static __thread int vhebusy;

/* resolved real libc symbols; never called directly by the engine */
typedef FILE *(*vhefopenfn)(const char *, const char *);
typedef FILE *(*vhefreopenfn)(const char *, const char *, FILE *);
typedef int    (*vheopenfn)(const char *, int, ...);
typedef int    (*vheopenatfn)(int, const char *, int, ...);
typedef int    (*vhestatfn)(const char *, struct stat *);
typedef int    (*vheaccessfn)(const char *, int);
typedef int    (*vhesysinfofn)(struct sysinfo *);
typedef int    (*vheunamefn)(struct utsname *);
typedef int    (*vhemkdirfn)(const char *, mode_t);

static struct {
    vhefopenfn    fopen;
    vhefopenfn    fopen64;
    vhefreopenfn  freopen;
    vhefreopenfn  freopen64;
    vheopenfn     open;
    vheopenfn     open64;
    vheopenatfn   openat;
    vheopenatfn   openat64;
    vhestatfn     stat;
    vhestatfn     lstat;
    vheaccessfn   access;
    vhesysinfofn  sysinfo;
    vheunamefn    uname;
    vhemkdirfn    mkdir;
} vhereal;

/**
 * logs a debug line to fd 2 when VHE_DEBUG=1. dprintf never allocates a FILE
 * stream and never calls open, so the logger cannot reenter the hooks.
 * @param fmt  printf-style format string
 * @return     nothing; errors on fd 2 are intentionally ignored
 */
static void vhelog(const char *fmt, ...)
{
    char msg[256];
    va_list ap;
    int n;

    if (!vhecfg.debug)
        return;
    va_start(ap, fmt);
    n = vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);
    if (n < 0)
        return;
    (void)dprintf(2, "[vhe] %s\n", msg);
}

/**
 * resolves one real libc symbol through dlsym(RTLD_NEXT, name). RTLD_NEXT is
 * required (never RTLD_DEFAULT) because the library itself defines the symbol
 * and a default lookup would find the hook again, looping forever.
 * @param name  symbol name such as "openat" or "sysinfo"
 * @return      function pointer, or NULL when no later object exports it
 */
static void *vheresolve(const char *name)
{
    void *sym = dlsym(RTLD_NEXT, name);
    if (sym == NULL)
        vhelog("cannot resolve %s: %s", name, dlerror() ? dlerror() : "?");
    return sym;
}

/**
 * checks readability without recursing into the interposed access() hook.
 * the raw syscall is used because the guard thread and constructor may run
 * before the caller expects any interception at all.
 * @param path  absolute path to probe
 * @return      1 when readable, 0 otherwise
 */
static int vhepathreadable(const char *path)
{
    if (path == NULL)
        return 0;
    return syscall(SYS_faccessat, AT_FDCWD, path, R_OK, 0) == 0;
}

/**
 * reads a positive unsigned long from an environment variable.
 * @param name        variable name
 * @param fallback    value used when unset, empty or malformed
 * @return            parsed value or fallback (strtoul with full validation)
 */
static unsigned long vheenvulong(const char *name, unsigned long fallback)
{
    const char *raw = getenv(name);
    char *end = NULL;
    unsigned long val;

    if (raw == NULL || *raw == '\0')
        return fallback;
    errno = 0;
    val = strtoul(raw, &end, 10);
    if (errno != 0 || end == raw || *end != '\0')
        return fallback;
    return val;
}

/**
 * reads an optional string variable, returning NULL for unset or empty so
 * callers can keep their defaults without extra branches.
 * @param name  variable name
 * @return      pointer into the environment, or NULL
 */
static const char *vheenvstr(const char *name)
{
    const char *raw = getenv(name);
    return (raw != NULL && *raw != '\0') ? raw : NULL;
}

/**
 * builds the private dynamic-mode directory (/tmp/.vhe-<uid>) used for the
 * regenerated meminfo, uptime and loadavg files, following the memoverlay
 * pattern of writing scaled copies outside procfs (procfs is read-only and
 * does not support inotify watches, so the scaled copy must live on tmpfs).
 * @return  nothing; failure downgrades the library to static mode
 */
static void vhepreparescratch(void)
{
    int rc = snprintf(vhecfg.scratchdir, sizeof(vhecfg.scratchdir),
                      "%s-%ld", VHETMPPREFIX, (long)getuid());
    if (rc < 0 || (size_t)rc >= sizeof(vhecfg.scratchdir)) {
        vhecfg.scratchdir[0] = '\0';
        return;
    }
    if (vhereal.mkdir == NULL)
        vhereal.mkdir = (vhemkdirfn)vheresolve("mkdir");
    if (vhereal.mkdir == NULL ||
        (vhereal.mkdir(vhecfg.scratchdir, 0700) != 0 && errno != EEXIST)) {
        vhelog("scratch dir %s unusable, dynamic meminfo disabled",
                vhecfg.scratchdir);
        vhecfg.scratchdir[0] = '\0';
    }
}

/**
 * joins the scratch directory and a leaf name into a fixed buffer.
 * @param out    output buffer
 * @param outsz  buffer size
 * @param leaf   file name such as "meminfo"
 * @return       0 on success, -1 on truncation (caller falls back safely)
 */
static int vhescratchpath(char *out, size_t outsz, const char *leaf)
{
    int rc;
    if (vhecfg.scratchdir[0] == '\0')
        return -1;
    rc = snprintf(out, outsz, "%s/%s", vhecfg.scratchdir, leaf);
    return (rc < 0 || (size_t)rc >= outsz) ? -1 : 0;
}

/**
 * deterministic pseudo-random 32-bit walk (xorshift32) used to derive stable
 * per-refresh values for meminfo, so successive reads look alive without a
 * real prng dependency.
 * @param seed  previous state, any nonzero value
 * @return      next state
 */
static uint32_t vhenextrand(uint32_t *seed)
{
    uint32_t x = *seed ? *seed : 0x9e3779b9u;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *seed = x;
    return x;
}

/**
 * reads the real uptime seconds from /proc/uptime through the raw openat
 * syscall, bypassing the hooks on purpose: the dynamic layer anchors every
 * virtual value added to the real monotonic uptime of the container.
 * @return  uptime in seconds, or 0 when unreadable (defensive)
 */
static unsigned long vherealuptime(void)
{
    char buf[128];
    ssize_t n;
    int fd = (int)syscall(SYS_openat, AT_FDCWD, "/proc/uptime", O_RDONLY, 0);
    if (fd < 0)
        return 0;
    n = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (n <= 0)
        return 0;
    buf[n] = '\0';
    return (unsigned long)strtoul(buf, NULL, 10);
}

/**
 * regenerates the dynamic virtual files: meminfo, uptime and loadavg. the layout
 * mirrors a real 6.x kernel meminfo (40+ fields in kB) scaled from
 * VHE_TOTALRAM_GB; MemFree keeps the dolos ratio total/4 for consistency with
 * the sysinfo() hook, Buffers total/16, Cached a drifting fraction so tools
 * polling twice observe movement (the memoverlay inotify thread behavior).
 * @return  nothing; failures only disable individual leaves
 */
static void vheregenerate(void)
{
    char path[192];
    unsigned long totalkb = vhecfg.totalrambytes / VHEKIB;
    unsigned long uptime = vherealuptime() + vhecfg.uptimebase;
    unsigned long freekb = totalkb / 4;
    unsigned long bufferskb = totalkb / 16;
    unsigned long cachedkb, availkb, usedkb, loads[3];
    uint32_t seed = (uint32_t)uptime | 1u;
    int fd, i;

    vhebusy = 1; /* internal writes must not be re-intercepted */

    /* meminfo: MemFree keeps the fixed dolos ratio total/4 so the sysinfo()
     * hook and the file view always agree; the drifting fields are the
     * caches, giving polling tools visible movement across refreshes. */
    usedkb = totalkb / 5 + (vhenextrand(&seed) % (totalkb / 20));
    cachedkb = totalkb / 4 + (vhenextrand(&seed) % (totalkb / 16));
    bufferskb += vhenextrand(&seed) % (totalkb / 64);
    availkb = freekb + cachedkb + bufferskb;

    if (vhescratchpath(path, sizeof(path), "meminfo") == 0) {
        fd = (int)syscall(SYS_openat, AT_FDCWD, path,
                          O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd >= 0) {
            dprintf(fd, "MemTotal:       %10lu kB\n", totalkb);
            dprintf(fd, "MemFree:        %10lu kB\n", freekb);
            dprintf(fd, "MemAvailable:   %10lu kB\n", availkb);
            dprintf(fd, "Buffers:        %10lu kB\n", bufferskb);
            dprintf(fd, "Cached:         %10lu kB\n", cachedkb);
            dprintf(fd, "SwapCached:     %10lu kB\n", 0UL);
            dprintf(fd, "Active:         %10lu kB\n", usedkb + cachedkb / 2);
            dprintf(fd, "Inactive:       %10lu kB\n", cachedkb / 2);
            dprintf(fd, "Active(anon):   %10lu kB\n", usedkb);
            dprintf(fd, "Inactive(anon): %10lu kB\n", usedkb / 8);
            dprintf(fd, "Active(file):   %10lu kB\n", cachedkb / 2);
            dprintf(fd, "Inactive(file): %10lu kB\n", cachedkb / 2);
            dprintf(fd, "Unevictable:    %10lu kB\n", 0UL);
            dprintf(fd, "Mlocked:        %10lu kB\n", 0UL);
            dprintf(fd, "SwapTotal:      %10lu kB\n", totalkb / 2);
            dprintf(fd, "SwapFree:       %10lu kB\n", totalkb / 2);
            dprintf(fd, "Zswap:          %10lu kB\n", 0UL);
            dprintf(fd, "Zswapped:       %10lu kB\n", 0UL);
            dprintf(fd, "Dirty:          %10lu kB\n", totalkb / 512);
            dprintf(fd, "Writeback:      %10lu kB\n", 0UL);
            dprintf(fd, "AnonPages:      %10lu kB\n", usedkb);
            dprintf(fd, "Mapped:         %10lu kB\n", usedkb / 4);
            dprintf(fd, "Shmem:          %10lu kB\n", totalkb / 128);
            dprintf(fd, "KReclaimable:   %10lu kB\n", totalkb / 64);
            dprintf(fd, "Slab:           %10lu kB\n", totalkb / 32);
            dprintf(fd, "SReclaimable:   %10lu kB\n", totalkb / 64);
            dprintf(fd, "SUnreclaim:     %10lu kB\n", totalkb / 64);
            dprintf(fd, "KernelStack:    %10lu kB\n", totalkb / 2048);
            dprintf(fd, "PageTables:     %10lu kB\n", totalkb / 1024);
            dprintf(fd, "NFS_Unstable:   %10lu kB\n", 0UL);
            dprintf(fd, "Bounce:         %10lu kB\n", 0UL);
            dprintf(fd, "WritebackTmp:   %10lu kB\n", 0UL);
            dprintf(fd, "CommitLimit:    %10lu kB\n", totalkb);
            dprintf(fd, "Committed_AS:   %10lu kB\n", usedkb * 2);
            dprintf(fd, "VmallocTotal:  %10lu kB\n", 34359738367UL);
            dprintf(fd, "VmallocUsed:    %10lu kB\n", totalkb / 128);
            dprintf(fd, "VmallocChunk:   %10lu kB\n", 0UL);
            dprintf(fd, "Percpu:         %10lu kB\n", totalkb / 2048);
            dprintf(fd, "HardwareCorrupted: %7lu kB\n", 0UL);
            dprintf(fd, "AnonHugePages:  %10lu kB\n", 0UL);
            dprintf(fd, "ShmemHugePages: %10lu kB\n", 0UL);
            dprintf(fd, "FileHugePages:  %10lu kB\n", 0UL);
            dprintf(fd, "HugePages_Total:    %7lu\n", 0UL);
            dprintf(fd, "HugePages_Free:     %7lu\n", 0UL);
            dprintf(fd, "HugePages_Rsvd:     %7lu\n", 0UL);
            dprintf(fd, "HugePages_Surp:     %7lu\n", 0UL);
            dprintf(fd, "Hugepagesize:       %7lu kB\n", 2048UL);
            dprintf(fd, "Hugetlb:        %10lu kB\n", 0UL);
            dprintf(fd, "DirectMap4k:    %10lu kB\n", totalkb / 64);
            dprintf(fd, "DirectMap2M:    %10lu kB\n", totalkb / 2);
            dprintf(fd, "DirectMap1G:    %10lu kB\n", totalkb / 2);
            close(fd);
        } else {
            vhelog("regenerate meminfo failed on %s: errno=%d", path, errno);
        }
    } else {
        vhelog("scratch meminfo unavailable, skipping regeneration");
    }

    if (vhescratchpath(path, sizeof(path), "uptime") == 0 &&
        (fd = (int)syscall(SYS_openat, AT_FDCWD, path,
                           O_WRONLY | O_CREAT | O_TRUNC, 0644)) >= 0) {
        dprintf(fd, "%lu.%02lu %lu.%02lu\n",
                uptime, vhenextrand(&seed) % 100UL,
                uptime * 3 / 4, vhenextrand(&seed) % 100UL);
        close(fd);
    }

    if (vhescratchpath(path, sizeof(path), "loadavg") == 0 &&
        (fd = (int)syscall(SYS_openat, AT_FDCWD, path,
                           O_WRONLY | O_CREAT | O_TRUNC, 0644)) >= 0) {
        for (i = 0; i < 3; i++)
            loads[i] = vhenextrand(&seed) % (vhecfg.cpus * 80 / 100);
        dprintf(fd, "%lu.%02lu %lu.%02lu %lu.%02lu %lu/%lu\n",
                loads[0] / 100, loads[0] % 100,
                loads[1] / 100, loads[1] % 100,
                loads[2] / 100, loads[2] % 100,
                64UL + vhenextrand(&seed) % 512UL, vhecfg.cpus * 4);
        close(fd);
    }
    vhebusy = 0;
}

/**
 * watcher thread body, the memoverlay inotify pattern. the thread watches the
 * /etc/virtual configuration directory (IN_CLOSE_WRITE | IN_MOVED_TO) so an
 * operator editing meminfo triggers an immediate regeneration, and poll()
 * doubles as the periodic timer (VHE_MEMINFO_REFRESH) that keeps the dynamic
 * values moving even without manual edits. when inotify or the config
 * directory are unavailable the loop degrades to a pure nanosleep timer.
 * @param arg  unused
 * @return     NULL always
 */
static void *vhewatcher(void *arg)
{
    char buf[sizeof(struct inotify_event) + NAME_MAX + 1];
    struct inotify_event *ev;
    int ifd = inotify_init1(IN_CLOEXEC);
    int wd = -1;
    ssize_t n;
    char *p;

    (void)arg;
    if (ifd >= 0)
        wd = inotify_add_watch(ifd, VHEETCBASE,
                               IN_CLOSE_WRITE | IN_MOVED_TO);
    vhelog("watcher started (ifd=%d wd=%d refresh=%us dynamic=%d)",
            ifd, wd, vhecfg.refreshsecs, vhecfg.dynamicmem);

    while (!vhestop) {
        if (ifd >= 0 && wd >= 0) {
            struct pollfd pfd = { ifd, POLLIN, 0 };
            int prc = poll(&pfd, 1, (int)vhecfg.refreshsecs * 1000);
            if (prc > 0 && (pfd.revents & POLLIN)) {
                n = read(ifd, buf, sizeof(buf));
                if (n > 0) {
                    for (p = buf; p < buf + n;
                         p += sizeof(*ev) + (size_t)ev->len) {
                        ev = (struct inotify_event *)p;
                        vhelog("config event 0x%x on %.*s", ev->mask,
                                (int)ev->len, ev->name);
                    }
                }
            } else if (prc < 0 && errno != EINTR) {
                vhelog("poll failed: errno=%d", errno);
                break;
            }
        } else {
            struct timespec ts;
            ts.tv_sec = (time_t)vhecfg.refreshsecs;
            ts.tv_nsec = 0;
            nanosleep(&ts, NULL);
        }
        if (vhecfg.dynamicmem)
            vheregenerate();
    }
    if (ifd >= 0) {
        if (wd >= 0)
            inotify_rm_watch(ifd, wd);
        close(ifd);
    }
    return NULL;
}

/**
 * one-shot initializer, executed under pthread_once from the constructor or
 * from the first hook invocation, whichever happens first. resolves every
 * real symbol, evaluates the environment, probes /etc/virtual and decides
 * the redirect table. any failure leaves the corresponding hook disabled,
 * which makes the library fail open (binaries keep running against the real
 * procfs) instead of breaking the process.
 */
static void vheinitonce(void)
{
    const char *env;
    char etc[192];

    memset(&vhecfg, 0, sizeof(vhecfg));
    vhecfg.totalrambytes = VHEDEFAULTRAMGB * VHEGIB;
    vhecfg.cpus = VHEDEFAULTCPUS;
    vhecfg.refreshsecs = VHEREFRESHSECS;
    vhecfg.release = VHEDEFAULTRELEASE;
    vhecfg.version = VHEDEFAULTVERSION;
    vhecfg.sysname = "Linux";
    vhecfg.machine = "x86_64";
    vhecfg.enabled = 1;

    vhereal.fopen   = (vhefopenfn)vheresolve("fopen");
    vhereal.fopen64 = (vhefopenfn)vheresolve("fopen64");
    vhereal.freopen = (vhefreopenfn)vheresolve("freopen");
    vhereal.freopen64 = (vhefreopenfn)vheresolve("freopen64");
    vhereal.open    = (vheopenfn)vheresolve("open");
    vhereal.open64  = (vheopenfn)vheresolve("open64");
    vhereal.openat  = (vheopenatfn)vheresolve("openat");
    vhereal.openat64 = (vheopenatfn)vheresolve("openat64");
    vhereal.stat    = (vhestatfn)vheresolve("stat");
    vhereal.lstat   = (vhestatfn)vheresolve("lstat");
    vhereal.access  = (vheaccessfn)vheresolve("access");
    vhereal.sysinfo = (vhesysinfofn)vheresolve("sysinfo");
    vhereal.uname   = (vheunamefn)vheresolve("uname");

    vhecfg.totalrambytes = vheenvulong("VHE_TOTALRAM_GB",
                                           VHEDEFAULTRAMGB) * VHEGIB;
    vhecfg.cpus = vheenvulong("VHE_CPUS", VHEDEFAULTCPUS);
    vhecfg.uptimebase = vheenvulong("VHE_UPTIME", 0);
    vhecfg.refreshsecs = (unsigned)vheenvulong("VHE_MEMINFO_REFRESH",
                                                   VHEREFRESHSECS);
    if ((env = vheenvstr("VHE_KERNEL_RELEASE")) != NULL)
        vhecfg.release = env;
    if ((env = vheenvstr("VHE_KERNEL_VERSION")) != NULL)
        vhecfg.version = env;
    if ((env = vheenvstr("VHE_SYSNAME")) != NULL)
        vhecfg.sysname = env;
    if ((env = vheenvstr("VHE_MACHINE")) != NULL)
        vhecfg.machine = env;
    vhecfg.debug = vheenvulong("VHE_DEBUG", 0) != 0;
    vhecfg.enabled = vheenvulong("VHE_ENABLED", 1) != 0;

    /* redirect resolution order per source, all defensive:
     *   1. explicit env override (VHE_CPUINFO, VHE_MEMINFO, ...)
     *   2. /etc/virtual/<leaf> baked into the docker image
     *   3. dynamic scratch copy for meminfo/uptime/loadavg
     *   4. NULL = passthrough to the real procfs entry
     */
    if ((env = vheenvstr("VHE_CPUINFO")) != NULL &&
        vhepathreadable(env))
        vhecfg.cpuinfopath = env;
    else if (snprintf(etc, sizeof(etc), "%s/cpuinfo", VHEETCBASE) > 0 &&
             vhepathreadable(etc))
        vhecfg.cpuinfopath = VHEETCBASE "/cpuinfo";

    /* memoverlay default: the watcher regenerates a scaled meminfo copy; the
     * operator opts out with VHE_MEMINFO_MODE=static or an explicit file. */
    if ((env = vheenvstr("VHE_MEMINFO_MODE")) != NULL)
        vhecfg.dynamicmem = strcmp(env, "static") != 0;
    else
        vhecfg.dynamicmem = 1;
    if (vheenvstr("VHE_MEMINFO") != NULL)
        vhecfg.dynamicmem = 0; /* explicit file implies static mode */

    if ((env = vheenvstr("VHE_MEMINFO")) != NULL && vhepathreadable(env))
        vhecfg.meminfopath = env;
    else if (!vhecfg.dynamicmem &&
             snprintf(etc, sizeof(etc), "%s/meminfo", VHEETCBASE) > 0 &&
             vhepathreadable(etc))
        vhecfg.meminfopath = VHEETCBASE "/meminfo";

    if ((env = vheenvstr("VHE_UPTIME_PATH")) != NULL && vhepathreadable(env))
        vhecfg.uptimepath = env;
    else if (snprintf(etc, sizeof(etc), "%s/uptime", VHEETCBASE) > 0 &&
             vhepathreadable(etc))
        vhecfg.uptimepath = VHEETCBASE "/uptime";

    if ((env = vheenvstr("VHE_LOADAVG_PATH")) != NULL && vhepathreadable(env))
        vhecfg.loadavgpath = env;
    else if (snprintf(etc, sizeof(etc), "%s/loadavg", VHEETCBASE) > 0 &&
             vhepathreadable(etc))
        vhecfg.loadavgpath = VHEETCBASE "/loadavg";

    if ((env = vheenvstr("VHE_VERSION_PATH")) != NULL && vhepathreadable(env))
        vhecfg.versionpath = env;
    else if (snprintf(etc, sizeof(etc), "%s/version", VHEETCBASE) > 0 &&
             vhepathreadable(etc))
        vhecfg.versionpath = VHEETCBASE "/version";

    if (vhecfg.dynamicmem) {
        vhepreparescratch();
        if (vhecfg.scratchdir[0] == '\0') {
            /* no writable scratch: degrade to static mode defensively */
            vhecfg.dynamicmem = 0;
            if (snprintf(etc, sizeof(etc), "%s/meminfo", VHEETCBASE) > 0 &&
                vhepathreadable(etc))
                vhecfg.meminfopath = VHEETCBASE "/meminfo";
        }
    }

    /* first generation before any consumer can observe the scratch tree */
    if (vhecfg.dynamicmem)
        vheregenerate();

    if (vhecfg.dynamicmem) {
        if (vhescratchpath(etc, sizeof(etc), "meminfo") == 0)
            vhecfg.meminfopath = strdup(etc);
        if (vhecfg.uptimepath == NULL &&
            vhescratchpath(etc, sizeof(etc), "uptime") == 0)
            vhecfg.uptimepath = strdup(etc);
        if (vhecfg.loadavgpath == NULL &&
            vhescratchpath(etc, sizeof(etc), "loadavg") == 0)
            vhecfg.loadavgpath = strdup(etc);
    }
    if (vhecfg.versionpath == NULL && vhecfg.dynamicmem &&
        vhescratchpath(etc, sizeof(etc), "version") == 0) {
        int fd = (int)syscall(SYS_openat, AT_FDCWD, etc,
                              O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (fd >= 0) {
            dprintf(fd, "Linux version %s (vhe-builder@vhe) "
                        "(clang version 19.1.0) %s\n",
                    vhecfg.release, vhecfg.version);
            close(fd);
            vhecfg.versionpath = strdup(etc);
        }
    }

    if (vhecfg.dynamicmem) {
        vhestop = 0;
        if (pthread_create(&vhewatcherthread, NULL, vhewatcher, NULL) != 0)
            vhelog("watcher thread creation failed: errno=%d", errno);
    }

    vhelog("initialized ram=%luGiB cpus=%lu cpuinfo=%s meminfo=%s "
            "dynamic=%d release=%s",
            vhecfg.totalrambytes >> 30, vhecfg.cpus,
            vhecfg.cpuinfopath ? vhecfg.cpuinfopath : "(real)",
            vhecfg.meminfopath ? vhecfg.meminfopath : "(real)",
            vhecfg.dynamicmem, vhecfg.release);
}

/**
 * lazy-init shim invoked at the top of every hook: cheap once pthread_once
 * has completed, and it covers processes that load the library through an
 * explicit dlopen() after startup (no constructor run for them).
 */
static void vheensure(void)
{
    pthread_once(&vheonce, vheinitonce);
}

/**
 * translates an intercepted procfs path to its virtual replacement.
 * @param path  path as passed by the caller (may be NULL or relative)
 * @return      replacement path, or NULL when the request must pass through
 */
static const char *vhetranslate(const char *path)
{
    if (path == NULL || path[0] != '/' || vhebusy || !vhecfg.enabled)
        return NULL;
    if (strcmp(path, "/proc/cpuinfo") == 0)
        return vhecfg.cpuinfopath;
    if (strcmp(path, "/proc/meminfo") == 0)
        return vhecfg.meminfopath;
    if (strcmp(path, "/proc/uptime") == 0)
        return vhecfg.uptimepath;
    if (strcmp(path, "/proc/loadavg") == 0)
        return vhecfg.loadavgpath;
    if (strcmp(path, "/proc/version") == 0)
        return vhecfg.versionpath;
    return NULL;
}

/**
 * shared implementation for open() and open64(): pulls the optional mode
 * argument exactly like glibc does for O_CREAT and O_TMPFILE, translates the
 * path and forwards to the resolved real function. relative paths are never
 * rewritten because their meaning depends on dirfd (and procfs targets are
 * always absolute).
 * @param real   resolved real open/open64
 * @param path   caller path
 * @param flags  open flags
 * @param ap     va_list positioned at the optional mode
 * @return       file descriptor or -1 with errno set by the real function
 */
static int vheopencommon(vheopenfn real, const char *path, int flags,
                           va_list ap)
{
    const char *mapped = vhetranslate(path);
    mode_t mode = 0;

    if (flags & (O_CREAT | O_TMPFILE))
        mode = (mode_t)va_arg(ap, int); /* mode_t promotes through varargs */
    if (mapped != NULL) {
        vhelog("open %s -> %s", path, mapped);
        return real(mapped, flags, mode);
    }
    return real(path, flags, mode);
}

/**
 * hook for open(3). the full family is required: coreutils and many daemons
 * issue openat instead of open (stackoverflow.com/questions/77489799 shows
 * netstat reaching procfs only through openat), so hooking open alone leaks
 * the real hardware to a large class of tools.
 */
int open(const char *path, int flags, ...)
{
    va_list ap;
    int rc;

    vheensure();
    va_start(ap, flags);
    rc = vheopencommon(vhereal.open, path, flags, ap);
    va_end(ap);
    return rc;
}

/** hook for open64(3), the legacy large-file entry point still present in
 *  every glibc build; older java and fortran runtimes reach procfs here. */
int open64(const char *path, int flags, ...)
{
    va_list ap;
    int rc;

    vheensure();
    va_start(ap, flags);
    rc = vheopencommon(vhereal.open64, path, flags, ap);
    va_end(ap);
    return rc;
}

/**
 * shared implementation for openat()/openat64(). only absolute paths are
 * translated; a relative "cpuinfo" resolved through dirfd must keep its
 * caller-provided meaning.
 * @param real   resolved real openat/openat64
 * @param dirfd  directory file descriptor
 * @param path   caller path
 * @param flags  open flags
 * @param ap     va_list positioned at the optional mode
 * @return       file descriptor or -1 with errno set by the real function
 */
static int vheopenatcommon(vheopenatfn real, int dirfd, const char *path,
                             int flags, va_list ap)
{
    const char *mapped = vhetranslate(path);
    mode_t mode = 0;

    if (flags & (O_CREAT | O_TMPFILE))
        mode = (mode_t)va_arg(ap, int);
    if (mapped != NULL) {
        vhelog("openat %s -> %s", path, mapped);
        return real(AT_FDCWD, mapped, flags, mode);
    }
    return real(dirfd, path, flags, mode);
}

/** hook for openat(2), the modern glibc entry point used by coreutils. */
int openat(int dirfd, const char *path, int flags, ...)
{
    va_list ap;
    int rc;

    vheensure();
    va_start(ap, flags);
    rc = vheopenatcommon(vhereal.openat, dirfd, path, flags, ap);
    va_end(ap);
    return rc;
}

/** hook for openat64(2), large-file variant of openat. */
int openat64(int dirfd, const char *path, int flags, ...)
{
    va_list ap;
    int rc;

    vheensure();
    va_start(ap, flags);
    rc = vheopenatcommon(vhereal.openat64, dirfd, path, flags, ap);
    va_end(ap);
    return rc;
}

/**
 * hook for fopen(3), the entry point used by python (open()), perl, php and
 * most interpreted runtimes when they read /proc files.
 * @return  stream over the virtual file, or the real result on passthrough
 */
FILE *fopen(const char *path, const char *mode)
{
    const char *mapped;

    vheensure();
    mapped = vhetranslate(path);
    if (mapped != NULL) {
        vhelog("fopen %s -> %s", path, mapped);
        return vhereal.fopen(mapped, mode);
    }
    return vhereal.fopen(path, mode);
}

/** hook for fopen64(3), large-file fopen reached by some 32-bit builds. */
FILE *fopen64(const char *path, const char *mode)
{
    const char *mapped;

    vheensure();
    mapped = vhetranslate(path);
    if (mapped != NULL)
        return vhereal.fopen64(mapped, mode);
    return vhereal.fopen64(path, mode);
}

/**
 * hook for freopen(3). a NULL path means "reopen the current stream" and is
 * forwarded untouched; only real paths participate in translation.
 * @return  the reused stream from the real freopen
 */
FILE *freopen(const char *path, const char *mode, FILE *stream)
{
    const char *mapped;

    vheensure();
    if (path == NULL)
        return vhereal.freopen(NULL, mode, stream);
    mapped = vhetranslate(path);
    if (mapped != NULL) {
        vhelog("freopen %s -> %s", path, mapped);
        return vhereal.freopen(mapped, mode, stream);
    }
    return vhereal.freopen(path, mode, stream);
}

/** hook for freopen64(3), large-file variant of freopen. */
FILE *freopen64(const char *path, const char *mode, FILE *stream)
{
    const char *mapped;

    vheensure();
    if (path == NULL)
        return vhereal.freopen64(NULL, mode, stream);
    mapped = vhetranslate(path);
    if (mapped != NULL)
        return vhereal.freopen64(mapped, mode, stream);
    return vhereal.freopen64(path, mode, stream);
}

/**
 * shared implementation for stat() and lstat(): procfs entries are never
 * symlinks, so both hooks share one body and only translate the path before
 * the real call fills the caller-provided struct stat.
 * @param real  resolved real stat or lstat
 * @param path  caller path
 * @param buf   caller stat buffer
 * @return      0 on success, -1 with errno on failure
 */
static int vhestatcommon(vhestatfn real, const char *path,
                           struct stat *buf)
{
    const char *mapped = vhetranslate(path);

    if (mapped != NULL) {
        vhelog("stat %s -> %s", path, mapped);
        return real(mapped, buf);
    }
    return real(path, buf);
}

/** hook for stat(2); lscpu and monitoring agents stat procfs before reading. */
int stat(const char *path, struct stat *buf)
{
    vheensure();
    return vhestatcommon(vhereal.stat, path, buf);
}

/** hook for lstat(2); kept symmetric so symlink-aware tools stay consistent. */
int lstat(const char *path, struct stat *buf)
{
    vheensure();
    return vhestatcommon(vhereal.lstat, path, buf);
}

/**
 * hook for access(2). tools probing with access("/proc/cpuinfo", R_OK)
 * before reading must observe the virtual view too, otherwise they would
 * bypass the redirection and report the physical host.
 * @return  0 when the virtual path is accessible, real result otherwise
 */
int access(const char *path, int mode)
{
    const char *mapped;

    vheensure();
    mapped = vhetranslate(path);
    if (mapped != NULL) {
        vhelog("access %s -> %s", path, mapped);
        return vhereal.access(mapped, mode);
    }
    return vhereal.access(path, mode);
}

/**
 * hook for sysinfo(2), the syscall behind glibc's sysinfo() as used by busybox
 * free, some build systems and language runtimes. the dolos normalization is
 * mandatory: totalram is expressed in mem_unit units, so the fake byte count
 * must be divided by info->mem_unit or the value explodes by that factor
 * (dolos/hooks.c got this right; naive hooks report exabytes by accident).
 * ratios follow dolos: freeram = total/4, sharedram = total/32,
 * bufferram = total/16; swap mirrors total/2 fully free.
 * @param info  caller-provided sysinfo struct
 * @return      0 on success, -1 on real failure (passthrough, defensive)
 */
int sysinfo(struct sysinfo *info)
{
    int rc;

    vheensure();
    rc = vhereal.sysinfo(info);
    if (rc != 0 || info == NULL || !vhecfg.enabled)
        return rc;
    if (info->mem_unit == 0)
        info->mem_unit = 1; /* never divide by zero, glibc always sets it */
    info->totalram = vhecfg.totalrambytes / info->mem_unit;
    info->freeram = info->totalram / 4;
    info->sharedram = info->totalram / 32;
    info->bufferram = info->totalram / 16;
    info->totalswap = info->totalram / 2;
    info->freeswap = info->totalswap;
    if (vhecfg.uptimebase != 0)
        info->uptime += vhecfg.uptimebase;
    vhelog("sysinfo totalram=%lu units (mem_unit=%u)",
            info->totalram, info->mem_unit);
    return 0;
}

/**
 * copies one utsname field with hard bounds (__NEW_UTS_LEN + 1 per sys/utsname
 * semantics), never truncating the nul terminator.
 * @param dst   destination field inside struct utsname
 * @param dstsz field size (65 on linux)
 * @param src   replacement string, may be NULL for "keep real value"
 */
static void vhecopyuts(char *dst, size_t dstsz, const char *src)
{
    if (src == NULL || dst == NULL || dstsz == 0)
        return;
    snprintf(dst, dstsz, "%s", src);
}

/**
 * hook for uname(2). the real uname runs first so nodename and every field
 * the operator did not override stay authentic, then the configured fields
 * are rewritten (dolos also hooks gethostname; those symbols live in libc
 * proper and stay passthrough here to keep the preload surface minimal).
 * @param buf  caller-provided utsname
 * @return     0 on success, -1 on real failure (defensive passthrough)
 */
int uname(struct utsname *buf)
{
    int rc;

    vheensure();
    rc = vhereal.uname(buf);
    if (rc != 0 || buf == NULL || !vhecfg.enabled)
        return rc;
    vhecopyuts(buf->sysname, sizeof(buf->sysname), vhecfg.sysname);
    vhecopyuts(buf->release, sizeof(buf->release), vhecfg.release);
    vhecopyuts(buf->version, sizeof(buf->version), vhecfg.version);
    vhecopyuts(buf->machine, sizeof(buf->machine), vhecfg.machine);
    vhelog("uname release=%s machine=%s", buf->release, buf->machine);
    return 0;
}

/**
 * library constructor. priority 101 keeps it ahead of generic constructors
 * (0..100) so the redirect table is ready before any application constructor
 * reads /proc. runs under pthread_once so a dlopen-based load cannot double
 * initialize either.
 */
__attribute__((constructor(101)))
static void vhector(void)
{
    vheensure();
}

/**
 * library destructor: signals the watcher thread to stop. the thread is
 * detached-free (joined implicitly at process exit by the loader) and every
 * syscall it may touch is async-signal-safe enough for teardown.
 */
__attribute__((destructor(101)))
static void vhedtor(void)
{
    vhestop = 1;
    vhelog("shutdown requested");
}
