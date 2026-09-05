/*
 * gpumonitor.cpp — gpu identity spoofing suite for the virtual hardware
 * engine v5 (vhe), written against c++26.
 *
 * one translation unit, four build modes (see the dockerfile):
 *   1. CLI   (-DVHE_BUILD_CLI)     the virtual nvidia-smi adapter binary installed at
 *                                  /usr/local/bin/nvidia-smi; plain table,
 *                                  --query-gpu csv mode and -L device list,
 *                                  same surface as pogusthewhisper/fake-nvidia-smi.
 *   2. SHIM  (-DVHE_BUILD_PRELOAD) shared object exporting nvml* and cu*
 *                                  symbols; when preloaded (or symlinked as
 *                                  libnvidia-ml.so.1 / libcuda.so.1) it
 *                                  forwards to a real driver found after this
 *                                  object via dlsym(RTLD_NEXT, ...) and
 *                                  synthesizes data otherwise — the unified
 *                                  shim pattern from rick-hsu/nvml-unified-shim
 *                                  plus the libcuda entry-point interception
 *                                  documented by FanBB2333/GpuAdapter.
 *   3. ADDON (-DVHE_BUILD_ADDON)   node native addon (node_api.h, node 26.7.0,
 *                                  NODE_MODULE_VERSION 147) exporting the
 *                                  table generator to javascript.
 *   4. FORGE (-DVHE_BUILD_FORGE)   the aetherforge control plane (v2 merge of
 *                                  forge.cpp/forge.hpp): plan validation, the
 *                                  qemu 11.1.0 argv generator with hugepages,
 *                                  virtio-mem, swtpm tpm-crb, looking glass
 *                                  ivshmem and whpx accel, plus the mttg
 *                                  work-stealing grid model. the planner is
 *                                  the c++ mirror of the architect planner in
 *                                  index.ts and carries the flags the ts side
 *                                  leaves to operators.
 *
 * hardware numbers below were verified on 22/08/2026 against vendor pages
 * and the worklog task 1-d research:
 *   NVIDIA-SMI 575.57.08 / CUDA 12.9 header  (fake-nvidia-smi confirmed)
 *   A100-SXM4-40GB    40536 MiB   400 W
 *   H100-SXM5-80GB    81559 MiB   700 W
 *   GeForce RTX 5090  32768 MiB   575 W
 *   RTX PRO 6000      97887 MiB   600 W   (blackwell workstation, 96 GB)
 *   B200             196608 MiB  1000 W   (192 GB HBM3e)
 *
 * c++26 features exercised deliberately, each with a toolchain fallback:
 *   - import std;                    primary path; -DVHE_NO_MODULES switches
 *                                    to classic includes for libstdc++
 *                                    toolchains without the std module.
 *   - std::expected (p0323r12)      every renderer returns
 *                                    expected<string, spooferror> instead of
 *                                    throwing, so the CLI and the napi addon
 *                                    surface errors as values.
 *   - std::mdspan (p0009r18)        the spec matrix is a 2D non-owning view,
 *                                    extended sizes, operator() access.
 *   - pack indexing ts...[i]        default profile selection at compile time
 *                                    (p2662r3, c++26); __cpp_pack_indexing
 *                                    guards a std::forward_as_tuple fallback
 *                                    for clang-19/gcc-14 pre-adoption builds.
 *   - std::print / std::format      all console output; no printf anywhere.
 *
 * environment variables consumed (all optional):
 *   VHE_GPU_PROFILE   profile key: a100 (default), h100, rtx5090, rtxpro6000,
 *                     b200; aliases: 5090, pro6000, a100-40gb, h100-80gb
 *   VHE_GPUS          gpu count reported (default 8, DGX-class node)
 *   VHE_SMI_DRIVER    driver version string (default 575.57.08)
 *   VHE_SMI_CUDA      cuda version string (default 12.9)
 *   VHE_MIG           1 renders a MIG instance table inside the output
 *   VHE_DEBUG         1 prints interception decisions to stderr
 *
 * build (shim): clang++-19 -std=c++26 -O3 -march=native -flto -shared -fPIC
 *                   -ldl gpumonitor.cpp -o libgpumonitor.so
 * build (cli):   clang++-19 -std=c++26 -O3 -march=native -flto
 *                   -DVHE_BUILD_CLI gpumonitor.cpp -o nvidia-smi
 * build (addon): clang++-19 -std=c++26 -O3 -shared -fPIC -DVHE_BUILD_ADDON
 *                   -DNODE_GYP_MODULE_NAME=vhe_gpu -I/usr/include/node
 *                   gpumonitor.cpp -o vhe_gpu.node
 * build (forge): clang++-19 -std=c++26 -O3 -DVHE_BUILD_FORGE
 *                   gpumonitor.cpp -o aetherforge
 */

#ifdef VHE_NO_MODULES /* classic include path for toolchains without std module */
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <expected>
#include <format>
#include <optional>
#include <print>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <utility>
#include <vector>
#if __has_include(<mdspan>)
#include <mdspan>
#define VHEHAVESTDMDSPAN 1
#endif
#else /* c++26 named module: the whole standard library in one import */
import std;
#define VHEHAVESTDMDSPAN 1
#endif

#include <dlfcn.h> /* posix dlsym/RTLD_NEXT, outside the std module */

#ifdef VHE_BUILD_ADDON
#include <node_api.h> /* node 26 stable n-api, abi stable across versions */
#endif

namespace vhe {

/* ------------------------------------------------------------------ */
/* constants and real hardware specs                                   */
/* ------------------------------------------------------------------ */

/** summary table geometry: the real nvidia-smi frame is 89 columns wide;
 *  segment widths are 41 | 23 | 21 inner columns plus the four border
 *  characters, matching the 575.x layout byte for byte where it matters. */
inline constexpr std::size_t ksegleft  = 41;
inline constexpr std::size_t ksegmid   = 23;
inline constexpr std::size_t ksegright = 21;
inline constexpr std::size_t kinner     = 87; /* 41+23+21+2 separators */
inline constexpr std::size_t ktable     = 89;

/** driver and cuda identity printed in the header row (fake-nvidia-smi
 *  confirmed this exact pair for 2026 datacenter branches). */
inline constexpr std::string_view kdriverdefault = "575.57.08";
inline constexpr std::string_view kcudadefault   = "12.9";

/**
 * one gpu product entry. every numeric field comes from the vendor pages
 * verified in worklog task 1-d; the values are exactly what a real
 * nvidia-smi would print on the corresponding hardware.
 */
struct gpuspec {
    std::string_view   key;       /* profile lookup key                     */
    std::string_view   name;      /* marketing name shown in the table      */
    std::string_view   arch;      /* architecture tag for -L output         */
    unsigned long long totalmib; /* vram as nvidia-smi reports it (MiB)    */
    unsigned           powerw;   /* enforced power cap                     */
    unsigned           tempc;    /* healthy idle-ish temperature           */
    unsigned           fanpct;   /* fan percentage (datacenter: N/A)       */
    unsigned           utilpct;  /* steady-state utilization               */
    unsigned           pciegen;  /* generation for bus metadata            */
    unsigned           mig;       /* 1 = MIG capable (A100/H100/B200)       */
};

inline constexpr gpuspec speca100{
    "a100", "NVIDIA A100-SXM4-40GB", "ampere", 40536, 400, 45, 0, 97, 4, 1};
inline constexpr gpuspec spech100{
    "h100", "NVIDIA H100-SXM5-80GB", "hopper", 81559, 700, 43, 0, 99, 5, 1};
inline constexpr gpuspec specrtx5090{
    "rtx5090", "NVIDIA GeForce RTX 5090", "blackwell-geforce", 32768, 575,
    41, 30, 96, 5, 0};
inline constexpr gpuspec specrtxpro6000{
    "rtxpro6000", "NVIDIA RTX PRO 6000", "blackwell-workstation", 97887, 600,
    47, 32, 94, 5, 1};
inline constexpr gpuspec specb200{
    "b200", "NVIDIA B200", "blackwell-datacenter", 196608, 1000, 55, 0, 98, 6,
    1};

/** flat spec matrix consumed through std::mdspan below. column order:
 *  0 totalmib, 1 powerw, 2 tempc, 3 fanpct, 4 utilpct, 5 pciegen,
 *  6 mig, 7 bar1mib. rows follow the constexpr spec declaration order. */
inline constexpr std::array<unsigned, 8 * 5> kspecflat{
    40536,  400, 45,  0, 97, 4, 1, 32768,   /* a100        */
    81559,  700, 43,  0, 99, 5, 1, 131072,  /* h100        */
    32768,  575, 41, 30, 96, 5, 0, 32768,   /* rtx 5090    */
    97887,  600, 47, 32, 94, 5, 1, 131072,  /* rtx pro 6000*/
    196608, 1000, 55, 0, 98, 6, 1, 262144,  /* b200        */
};

/**
 * mdspan over the flat matrix. the c++23 std::mdspan view (p0009r18, adopted
 * into c++26 toolchains as a core library piece) gives bounds-checked-free
 * 2D indexing without owning storage; on toolchains without <mdspan> the
 * fallback keeps the same operator() surface so call sites never change.
 */
#if defined(VHEHAVESTDMDSPAN)
inline constexpr auto kspecs =
    std::mdspan<const unsigned, std::extents<std::size_t, 5, 8>>(
        kspecflat.data());
#else
/** minimal fixed-extent 2D view mirroring std::mdspan's call syntax. */
template <class T, std::size_t Rows, std::size_t Cols>
struct compatmdspan {
    const T* mdata;
    constexpr const T& operator()(std::size_t r, std::size_t c) const {
        return mdata[r * Cols + c];
    }
};
inline constexpr compatmdspan<const unsigned, 5, 8> kspecs{
    kspecflat.data()};
#endif

/**
 * returns the index-th element of a function parameter pack.
 * primary path uses c++26 pack indexing (p2662r3, `ts...[index]`); the
 * fallback covers gcc-14 and clang-19 libstdc++ builds where the feature is
 * not yet enabled, via std::forward_as_tuple + std::get.
 * @param index  compile-time position within the pack
 * @param ts     the pack elements
 * @return       reference to the selected element
 */
#if defined(__cpp_pack_indexing)
template <std::size_t index, typename... ts>
[[nodiscard]] constexpr decltype(auto) packat(ts&&... tspack) noexcept {
    return tspack...[index]; /* c++26 pack indexing */
}
#else
template <std::size_t index, typename... ts>
[[nodiscard]] constexpr decltype(auto) packat(ts&&... tspack) noexcept {
    return std::get<index>(std::forward_as_tuple(tspack...));
}
#endif

/**
 * compile-time default profile selection through pack indexing: the whole
 * chain from kspecs back to constexpr spec objects evaluates at compile
 * time, which the static_asserts below prove.
 * @param idx  profile index, 0=a100 .. 4=b200
 * @return     reference to the constexpr gpuspec
 */
template <std::size_t idx>
[[nodiscard]] constexpr const gpuspec& defaultprofile() {
    return packat<idx>(speca100, spech100, specrtx5090, specrtxpro6000,
                        specb200);
}

static_assert(defaultprofile<0>().totalmib == 40536,
              "pack-indexed a100 profile must carry 40536 MiB");
static_assert(defaultprofile<4>().powerw == 1000,
              "pack-indexed b200 profile must carry the 1000 W cap");
static_assert(kspecs(4, 0) == 196608, "mdspan row b200 must carry 196608 MiB");
static_assert(ktable == 2 + kinner, "table frame math must stay consistent");

/* ------------------------------------------------------------------ */
/* error handling: std::expected everywhere, no exceptions              */
/* ------------------------------------------------------------------ */

/** error taxonomy for the renderers; codes mirror nvidia-smi exit reasons. */
enum class spooferrc {
    unknownprofile,  /**< profile key not in the catalog               */
    invalidcount,    /**< gpu count outside [1, 256]                   */
    formatfailure,   /**< a row exceeded its fixed-width segment       */
};

/** rich error value carried by std::expected. */
struct spooferror {
    spooferrc   code;
    std::string  detail;
};

/** result type used by every renderer in this translation unit. */
using smiresult = std::expected<std::string, spooferror>;

/**
 * builds a spooferror with a formatted message.
 * @param code    error category
 * @param fmt     std::format style message
 * @return        the fully populated error value
 */
[[nodiscard]] inline spooferror makeerror(spooferrc code,
                                            std::string_view fmt) {
    return spooferror{code, std::string{fmt}};
}

/* ------------------------------------------------------------------ */
/* small text helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * truncates or left-pads a string to an exact segment width so the 89-column
 * frame can never be broken by a long gpu name.
 * @param s      input text
 * @param width  target width
 * @return       exactly width characters
 */
[[nodiscard]] inline std::string fit(std::string_view s, std::size_t width) {
    std::string out{s.substr(0, width)};
    if (out.size() < width)
        out.append(width - out.size(), ' ');
    return out;
}

/** right-aligned variant of fit(), used for numeric columns. */
[[nodiscard]] inline std::string fitr(std::string_view s,
                                       std::size_t width) {
    std::string out{s.substr(0, width)};
    if (out.size() < width)
        out.insert(0, width - out.size(), ' ');
    return out;
}

/**
 * fnv-1a 64-bit hash; produces stable pseudo-random-looking identifiers so
 * bus-ids and uuids survive repeated invocations (tools diff two samples).
 * @param data  bytes to hash
 * @param seed  mixing seed (gpu index, process pid, ...)
 * @return      64-bit digest
 */
[[nodiscard]] constexpr std::uint64_t fnv1a(std::string_view data,
                                            std::uint64_t seed) {
    std::uint64_t h = 0xcbf29ce484222325ULL ^ seed;
    for (char c : data) {
        h ^= static_cast<std::uint64_t>(static_cast<unsigned char>(c));
        h *= 0x100000001b3ULL;
    }
    return h;
}

/**
 * formats a digest as the nvidia uuid v4 shape used by nvidia-smi -L:
 * GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
 * @param h  digest bits
 * @return   40-character uuid string starting with "GPU-"
 */
[[nodiscard]] inline std::string gpuuuid(std::uint64_t h) {
    return std::format("GPU-{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
                       static_cast<unsigned>(h >> 32),
                       static_cast<unsigned>((h >> 16) & 0xffff),
                       static_cast<unsigned>(h & 0xffff),
                       static_cast<unsigned>((h >> 48) & 0xffff),
                       h & 0xffffffffffffULL);
}

/** reads an optional environment string; empty or unset yields nullopt. */
[[nodiscard]] inline std::optional<std::string> envstr(
    const char* name) {
    const char* raw = std::getenv(name);
    if (raw == nullptr || *raw == '\0')
        return std::nullopt;
    return std::string{raw};
}

/** reads an optional environment number with clamping, default fallback. */
[[nodiscard]] inline unsigned envuint(const char* name, unsigned fallback,
                                       unsigned lo, unsigned hi) {
    auto raw = envstr(name);
    if (!raw)
        return fallback;
    unsigned value = 0;
    try {
        value = static_cast<unsigned>(std::stoul(*raw));
    } catch (...) {
        return fallback; /* malformed input keeps the default, never throws */
    }
    return value < lo ? lo : (value > hi ? hi : value);
}

/**
 * resolves a profile key to its spec, accepting the documented aliases.
 * @param key  profile name or alias
 * @return     pointer to the constexpr spec, or an error value
 */
[[nodiscard]] smiresult resolveprofile(std::string_view key) {
    if (key == "a100" || key == "a100-40gb" || key == "A100")
        return std::string{speca100.name};
    if (key == "h100" || key == "h100-80gb" || key == "H100")
        return std::string{spech100.name};
    if (key == "rtx5090" || key == "5090" || key == "RTX5090")
        return std::string{specrtx5090.name};
    if (key == "rtxpro6000" || key == "pro6000" || key == "RTXPRO6000")
        return std::string{specrtxpro6000.name};
    if (key == "b200" || key == "B200")
        return std::string{specb200.name};
    return std::unexpected(makeerror(
        spooferrc::unknownprofile,
        std::format("unknown profile '{}': expected a100, h100, rtx5090, "
                    "rtxpro6000 or b200", key)));
}

/**
 * finds the full gpuspec for a resolved key. resolveprofile returns the
 * name; this helper maps names back to specs through the flat catalog.
 * @param key  profile key
 * @return     spec pointer or error
 */
[[nodiscard]] std::expected<const gpuspec*, spooferror> findspec(
    std::string_view key) {
    const gpuspec* catalog[] = {&speca100, &spech100, &specrtx5090,
                                 &specrtxpro6000, &specb200};
    for (const gpuspec* spec : catalog)
        if (spec->key == key)
            return spec;
    return std::unexpected(makeerror(
        spooferrc::unknownprofile,
        std::format("profile '{}' not present in the constexpr catalog", key)));
}

/* ------------------------------------------------------------------ */
/* the virtual nvidia-smi adapter renderer                                        */
/* ------------------------------------------------------------------ */

/**
 * renders the complete nvidia-smi summary: asctime timestamp, 89-column
 * frame, header row, one block per gpu (identity row + telemetry row),
 * processes section, and — when VHE_MIG=1 — a MIG instance table.
 * memory-used derives deterministically from fnv1a(name, index) so the
 * output is stable within a process but distinct per gpu, mirroring how
 * fake-nvidia-smi derives its realistic telemetry.
 * @param profile   profile key ("a100", "h100", ...)
 * @param gpucount number of devices to report
 * @param driver    driver version for the header (default 575.57.08)
 * @param cuda      cuda version for the header (default 12.9)
 * @param mig       1 renders MIG instances
 * @return          the full table text or a spooferror
 */
[[nodiscard]] smiresult rendertable(std::string_view profile,
                                      unsigned gpucount,
                                      std::string_view driver,
                                      std::string_view cuda, bool mig) {
    if (gpucount == 0 || gpucount > 256)
        return std::unexpected(makeerror(
            spooferrc::invalidcount,
            std::format("gpu count {} outside the supported [1, 256] range",
                        gpucount)));

    auto specorerr = findspec(profile);
    if (!specorerr)
        return std::unexpected(specorerr.error());
    const gpuspec& spec = **specorerr;

    const std::string fullborder = "+" + std::string(kinner, '-') + "+";
    const std::string segborder =
        "|" + std::string(ksegleft, '-') + "+" +
        std::string(ksegmid, '-') + "+" + std::string(ksegright, '-') +
        "|";
    const std::string segheavy =
        "|" + std::string(ksegleft, '=') + "+" +
        std::string(ksegmid, '=') + "+" + std::string(ksegright, '=') +
        "|";

    std::string out;
    out.reserve(1024 + gpucount * 180);

    /* timestamp exactly as asctime/nvidia-smi print it: %a %b %e %H:%M:%S %Y */
    const auto now = std::chrono::floor<std::chrono::seconds>(
        std::chrono::system_clock::now());
    out += std::format("{:%a %b %e %H:%M:%S %Y}\n", now);
    out += fullborder + "\n";
    out += "|" +
           fit(std::format(" NVIDIA-SMI {}   Driver Version: {}   "
                           "CUDA Version: {}",
                           driver, driver, cuda),
               kinner) +
           "|\n";
    out += segborder + "\n";
    out += "|" + fit(" GPU  Name                  Driver-Model", ksegleft) +
           "|" + fit(" Bus-Id        Disp.A", ksegmid) + "|" +
           fit(" Volatile Uncorr. ECC", ksegright) + "|\n";
    out += "|" + fit(" Fan  Temp   Perf          Pwr:Usage/Cap", ksegleft) +
           "|" + fit("           Memory-Usage", ksegmid) + "|" +
           fit(" GPU-Util  Compute M.", ksegright) + "|\n";
    out += segheavy + "\n";

    for (unsigned i = 0; i < gpucount; ++i) {
        const std::uint64_t digest = fnv1a(spec.name, i + 1);
        const unsigned long long usedmib =
            spec.totalmib / 10 +
            digest % (spec.totalmib / 20); /* 10%..15% used at idle */
        const unsigned draww = spec.powerw / 8 + digest % (spec.powerw / 4);
        const std::string bus =
            std::format("00000000:{:02X}:{:02X}.0", (7u + i * 4u) & 0xffu,
                        (i * 8u) & 0xffu);
        /* datacenter boards (A100/H100/B200) have no readable fan sensor,
         * nvidia-smi prints N/A; consumer/workstation boards report % */
        const std::string fan =
            spec.fanpct == 0 ? "N/A" : std::format("{}%", spec.fanpct);
        const std::string powerstr =
            std::format("{}W / {}W", draww, spec.powerw);

        out += "|" +
               fit(std::format(" {:>3}  {:<24}{:>9}  ", i, spec.name, "On"),
                   ksegleft) +
               "|" + fit(std::format(" {}  Off", bus), ksegmid) + "|" +
               fitr("0", ksegright) + "|\n";
        out += "|" +
               fit(std::format(" {:>3} {:>4}C {:>3}{:>18}", fan, spec.tempc,
                               "P0", powerstr),
                   ksegleft) +
               "|" +
               fit(std::format(" {}MiB / {}MiB", usedmib, spec.totalmib),
                   ksegmid) +
               "|" +
               fit(std::format("{:>6}{:>15}",
                               std::format("{}%", spec.utilpct),
                               mig ? "E. Process" : "Default"),
                   ksegright) +
               "|\n";
        if (i + 1 < gpucount)
            out += segborder + "\n";
    }

    out += segheavy + "\n";
    out += "|" + fit(" Processes:", kinner) + "|\n";
    if (mig && spec.mig) {
        out += "|" +
               fit("  GPU  GI  CI        PID   Type   Process Name          "
                   "     GPU Memory",
                   kinner) +
               "|\n";
        for (unsigned g = 0; g < gpucount && g < 8; ++g)
            out += "|" +
                   fit(std::format("   {:>3}  {:>2}  {:>2}    {:>7}   {:>4}   "
                                   "{:<20} {:>10}MiB",
                                   g, 0, 0, 20000 + g * 37, "C+G",
                                   "python", 2048 + g * 128),
                       kinner) +
                   "|\n";
    } else {
        out += "|" +
               fit(std::format("{:^{}}", "No running processes found",
                               kinner),
                   kinner) +
               "|\n";
    }
    out += fullborder + "\n";
    return out;
}

/** default field list for csv mode, matching the nvidia-smi column names. */
inline constexpr std::string_view kqueryfields =
    "index,name,uuid,driver_version,cuda_version,memory.total,memory.used,"
    "memory.free,power.draw,power.limit,temperature.gpu,utilization.gpu";

/**
 * renders nvidia-smi --query-gpu output in csv mode, the surface consumed
 * by most fleet tooling (run-ai/fake-gpu-operator and cuda-mock implement
 * the same subset). supported fields: index, name, uuid, driverversion,
 * cudaversion, memory.total, memory.used, memory.free, power.draw,
 * power.limit, temperature.gpu, utilization.gpu. unknown fields fail with
 * spooferrc::unknownprofile exactly like the real binary refuses them.
 * @param profile   profile key
 * @param gpucount device count
 * @param fields    comma-separated field list (may be empty for the default)
 * @param noheader  1 suppresses the csv header line
 * @param driver    driver version
 * @param cuda      cuda version
 * @return          csv text or a spooferror
 */
[[nodiscard]] smiresult renderquerycsv(std::string_view profile,
                                          unsigned gpucount,
                                          std::string_view fields,
                                          bool noheader,
                                          std::string_view driver,
                                          std::string_view cuda) {
    if (gpucount == 0 || gpucount > 256)
        return std::unexpected(makeerror(
            spooferrc::invalidcount,
            std::format("gpu count {} outside the supported [1, 256] range",
                        gpucount)));
    auto specorerr = findspec(profile);
    if (!specorerr)
        return std::unexpected(specorerr.error());
    const gpuspec& spec = **specorerr;

    /* split the field list once; empty input selects every column */
    std::vector<std::string> wanted;
    {
        std::string list{fields.empty() ? std::string_view{kqueryfields}
                                        : fields};
        std::size_t pos = 0;
        while (pos != std::string::npos) {
            std::size_t comma = list.find(',', pos);
            std::string token =
                list.substr(pos, comma == std::string::npos
                                      ? std::string::npos
                                      : comma - pos);
            /* nvidia-smi tolerates spaces after commas */
            while (!token.empty() && token.front() == ' ')
                token.erase(0, 1);
            while (!token.empty() && token.back() == ' ')
                token.pop_back();
            if (!token.empty())
                wanted.push_back(token);
            pos = (comma == std::string::npos) ? std::string::npos
                                               : comma + 1;
        }
    }
    if (wanted.empty())
        return std::unexpected(makeerror(spooferrc::formatfailure,
                                          "empty --query-gpu field list"));

    /* validate every requested field before emitting anything */
    for (const std::string& field : wanted) {
        if (field != "index" && field != "name" && field != "uuid" &&
            field != "driver_version" && field != "cuda_version" &&
            field != "memory.total" && field != "memory.used" &&
            field != "memory.free" && field != "power.draw" &&
            field != "power.limit" && field != "temperature.gpu" &&
            field != "utilization.gpu")
            return std::unexpected(makeerror(
                spooferrc::formatfailure,
                std::format("field \"{}\" is not a valid field to query",
                            field)));
    }

    std::string out;
    if (!noheader) {
        for (std::size_t f = 0; f < wanted.size(); ++f)
            out += std::format("{}{}", f ? ", " : "", wanted[f]);
        out += '\n';
    }
    for (unsigned i = 0; i < gpucount; ++i) {
        const std::uint64_t digest = fnv1a(spec.name, i + 1);
        const unsigned long long used =
            spec.totalmib / 10 + digest % (spec.totalmib / 20);
        for (std::size_t f = 0; f < wanted.size(); ++f) {
            const std::string& field = wanted[f];
            std::string value;
            if (field == "index")
                value = std::format("{}", i);
            else if (field == "name")
                value = std::string{spec.name};
            else if (field == "uuid")
                value = gpuuuid(digest);
            else if (field == "driver_version")
                value = std::string{driver};
            else if (field == "cuda_version")
                value = std::string{cuda};
            else if (field == "memory.total")
                value = std::format("{}", spec.totalmib);
            else if (field == "memory.used")
                value = std::format("{}", used);
            else if (field == "memory.free")
                value = std::format("{}", spec.totalmib - used);
            else if (field == "power.draw")
                value = std::format(
                    "{}", spec.powerw / 8 + digest % (spec.powerw / 4));
            else if (field == "power.limit")
                value = std::format("{}", spec.powerw);
            else if (field == "temperature.gpu")
                value = std::format("{}", spec.tempc);
            else /* utilization.gpu */
                value = std::format("{}", spec.utilpct);
            out += std::format("{}{}", f ? ", " : "", value);
        }
        out += '\n';
    }
    return out;
}

/**
 * renders nvidia-smi -L device list lines:
 * "GPU 0: NVIDIA A100-SXM4-40GB (UUID: GPU-...)".
 * @param profile   profile key
 * @param gpucount device count
 * @return          list text or a spooferror
 */
[[nodiscard]] smiresult renderdevicelist(std::string_view profile,
                                            unsigned gpucount) {
    auto specorerr = findspec(profile);
    if (!specorerr)
        return std::unexpected(specorerr.error());
    const gpuspec& spec = **specorerr;
    std::string out;
    for (unsigned i = 0; i < gpucount; ++i)
        out += std::format("GPU {}: {} (UUID: {})\n", i, spec.name,
                           gpuuuid(fnv1a(spec.name, i + 1)));
    return out;
}

} /* namespace vhe */

/* -------------------------------------------------------------------- */
/* aetherforge control plane (v2 merge of forge.cpp/forge.hpp, mode 4)    */
/* -------------------------------------------------------------------- */

namespace vhe::forge {

/** planner ceilings shared by validate() and the mttg grid; kvcpumax at
 *  4096 matches the modern qemu -smp maxcpus limit (qemu 11.1.0 raised the
 *  x86 topology ceiling the engine relies on for 192-vcpu EPYC guests). */
inline constexpr std::uint32_t kvcpumax      = 4096;
inline constexpr std::uint32_t kovercommitmax = 64;
inline constexpr std::uint32_t kmttgmax      = 1'000'000;

/** planner error taxonomy; the values mirror the architect planner errors
 *  surfaced by index.ts so operators see one vocabulary across runtimes. */
enum class Err : std::uint8_t {
    invalidplan,   /**< empty plan name or unparsable input              */
    overcommit,     /**< ratio above the 64x safety ceiling               */
    vendormismatch,/**< vfio plan without a matching host vendor         */
    missingvfio,   /**< vfio plan on a host without vfio support         */
    mttgfloor,     /**< mttg pool smaller than the vcpu count            */
};

/** gpu attachment strategy for the emitted command line. */
enum class GpuMode : std::uint8_t { vfio, vgpu, mig, virtio, none };

/** hypervisor acceleration backend; whpx (windows hypervisor platform) is
 *  the only windows-capable backend in the engine and exists nowhere else
 *  in the pool outside this planner and its ts mirror. */
enum class Accel : std::uint8_t { kvm, hvf, whpx, tcg };

/**
 * the complete lab plan, c++ mirror of the architect planner in index.ts.
 * the defaults describe the reference 9950x3d + rtx 5090 lab node. the c++
 * side owns the flags the ts planner delegates: hugepages file backend,
 * virtio-mem dimm, swtpm tpm-crb device and the looking glass ivshmem.
 */
struct Plan {
    std::string   name{"aether-lab"};
    std::string   cpuid{"r9-9950x3d"};
    std::string   gpuid{"rtx-5090"};
    std::uint32_t sockets{1};
    std::uint32_t dies{2};
    std::uint32_t cores{8};
    std::uint32_t threadspercore{2};
    std::uint32_t vcpus{16};
    std::uint32_t memorygib{64};
    std::uint32_t vramgib{32};
    std::uint32_t overcommit{1};
    std::uint32_t mttgthreads{4096};
    bool          mttg{true};
    bool          balloon{true};
    bool          virtiomem{true};
    bool          hugepages{true};
    bool          tpm{true};
    bool          lookingglass{true};
    GpuMode       gpu{GpuMode::vfio};
    Accel         accel{Accel::kvm};
};

/**
 * computes the full topology (sockets x dies x cores x threads) the -smp
 * line must be able to express through maxcpus.
 * @param p  the plan
 * @return    product of every topology dimension
 */
[[nodiscard]] constexpr std::uint32_t topology(const Plan& p) noexcept {
    return p.sockets * p.dies * p.cores * p.threadspercore;
}

/** maps an accel backend to its qemu -machine accel= spelling. */
[[nodiscard]] constexpr std::string_view accelname(Accel a) noexcept {
    switch (a) {
    case Accel::kvm: return "kvm";
    case Accel::hvf: return "hvf";
    case Accel::whpx: return "whpx";
    case Accel::tcg: return "tcg";
    }
    return "kvm";
}

/**
 * validates and normalizes a plan. clamps stay deliberately forgiving
 * (vcpus to 4096, overcommit to 64, mttg pool to one million threads,
 * threadspercore folded to 1 or 2) while structural violations (mttg
 * pool below the vcpu count, empty name) fail with a typed error.
 * @param p  candidate plan, modified in place when accepted
 * @return    the normalized plan or an Err code
 */
[[nodiscard]] std::expected<Plan, Err> validate(Plan p) {
    p.vcpus           = std::clamp(p.vcpus, 1u, kvcpumax);
    p.overcommit      = std::clamp(p.overcommit, 1u, kovercommitmax);
    p.threadspercore = p.threadspercore == 1 ? 1 : 2;
    if (p.mttg && p.mttgthreads < p.vcpus)
        return std::unexpected(Err::mttgfloor);
    p.mttgthreads = std::min(p.mttgthreads, kmttgmax);
    if (p.name.empty())
        return std::unexpected(Err::invalidplan);
    return p;
}

/**
 * emits the qemu 11.1.0 argv for the plan. this generator is the superset
 * of the ts planner: hugepages memory-backend-file with prealloc, the
 * virtio-mem-pci dimm (block granularity 2M, requested size memory/4), the
 * swtpm chardev/tpmdev/tpm-crb triplet, vfio behind a dedicated pcie-root
 * port rp1, venus-enabled virtio-gpu-gl under egl-headless and the looking
 * glass ivshmem-plain device on a shared /dev/shm memdev.
 * @param p  validated plan
 * @return    argv tokens, suitable for exec or shell quoting
 */
[[nodiscard]] std::vector<std::string> qemuargv(const Plan& p) {
    const auto topo    = topology(p);
    const auto maxcpus = std::max(p.vcpus, topo);
    std::vector<std::string> a{
        "qemu-system-x86_64",
        "-nodefaults",
        "-machine",
        std::format("q35,accel={},kernel-irqchip=split,hpet=off",
                    accelname(p.accel)),
        "-cpu",
        "host,kvm=on,l3-cache=on,topoext=on,host-cache-info=on,+x2apic",
        "-smp",
        std::format("cpus={},sockets={},dies={},cores={},threads={},maxcpus={}",
                    std::min(p.vcpus, topo), p.sockets, p.dies, p.cores,
                    p.threadspercore, maxcpus),
        "-m",
        std::format("{}G,slots=4,maxmem={}G", p.memorygib,
                    std::max(p.memorygib * 2, p.memorygib + 32)),
        "-name",
        std::format("{},debug-threads=on", p.name),
        "-nographic",
        "-serial",
        "mon:stdio",
        "-device",
        "virtio-balloon-pci,deflate-on-oom=on,free-page-reporting=on",
        "-device",
        "virtio-net-pci,netdev=n0,mq=on,vectors=10",
        "-netdev",
        "tap,id=n0,vhost=on,queues=4,script=no,downscript=no",
    };
    if (p.hugepages) {
        a.insert(a.end(),
                 {"-object",
                  std::format("memory-backend-file,id=mem0,size={}G,"
                              "mem-path=/dev/hugepages,share=on,prealloc=on",
                              p.memorygib),
                  "-numa", "node,memdev=mem0"});
    }
    if (p.virtiomem) {
        a.insert(a.end(),
                 {"-device",
                  std::format("virtio-mem-pci,id=vmem0,memdev=mem1,"
                              "requested-size={}G",
                              std::max(1u, p.memorygib / 4)),
                  "-object",
                  std::format("memory-backend-ram,id=mem1,size={}G",
                              std::max(1u, p.memorygib / 2))});
    }
    if (p.tpm) {
        a.insert(a.end(), {
            "-chardev", "socket,id=chrtpm,path=/run/swtpm/swtpm-sock",
            "-tpmdev", "emulator,id=tpm0,chardev=chrtpm",
            "-device", "tpm-crb,tpmdev=tpm0",
        });
    }
    switch (p.gpu) {
    case GpuMode::vfio:
        a.insert(a.end(), {
            "-device",
            "pcie-root-port,id=rp1,bus=pcie.0,slot=1,chassis=1,multifunction=on",
            "-device",
            "vfio-pci,host=01:00.0,bus=rp1,addr=00.0,multifunction=on,x-vga=on",
            "-vga", "none",
        });
        break;
    case GpuMode::virtio:
        a.insert(a.end(), {"-device", "virtio-gpu-gl,hostmem=8G,blob=on,venus=on",
                           "-display", "egl-headless,gl=on"});
        break;
    default:
        a.insert(a.end(), {"-vga", "none"});
        break;
    }
    if (p.lookingglass && p.gpu == GpuMode::vfio) {
        a.insert(a.end(), {
            "-device", "ivshmem-plain,memdev=ivshmem",
            "-object",
            "memory-backend-file,id=ivshmem,share=on,"
            "mem-path=/dev/shm/looking-glass,size=128M",
        });
    }
    if (p.mttg) {
        a.insert(a.end(),
                 {"-fw_cfg",
                  std::format("name=opt/aetherforge/mttg,string={}",
                              p.mttgthreads)});
    }
    return a;
}

/**
 * renders the argv as a copy-pasteable shell command; tokens containing
 * spaces or commas are single-quoted.
 * @param p  validated plan
 * @return    multi-line command text
 */
[[nodiscard]] std::string qemucommand(const Plan& p) {
    std::ostringstream os;
    bool first = true;
    for (const auto& tok : qemuargv(p)) {
        if (!first)
            os << " \\\n  ";
        first = false;
        if (tok.find(' ') != std::string::npos ||
            tok.find(',') != std::string::npos) {
            os << '\'' << tok << '\'';
        } else {
            os << tok;
        }
    }
    return os.str();
}

/**
 * mttg (multi-threaded tcg) grid model: host lanes multiplex a larger
 * virtual thread pool by parking the surplus and rotating parked threads
 * onto idle lanes (work stealing). the counters feed the multiplex ratio
 * the engine prints next to every emitted plan.
 */
class Mttg {
public:
    /**
     * builds the grid from the host lane count and the requested virtual
     * pool; the runnable set never exceeds the host lanes.
     * @param hostthreads    physical lanes (>= 1)
     * @param virtualthreads requested pool size
     */
    explicit Mttg(std::uint32_t hostthreads, std::uint32_t virtualthreads)
        : mhost(std::max(1u, hostthreads)),
          mvirtual(std::max(mhost, virtualthreads)),
          mrunnable(std::min(mhost, mvirtual)) {
        mparked = mvirtual - mrunnable;
    }

    /** grows the virtual pool by n threads, unparking as lanes free up. */
    void spawn(std::uint32_t n) {
        mvirtual = std::min(kmttgmax, mvirtual + n);
        const auto want = std::min(mhost, mvirtual);
        if (mrunnable < want) {
            const auto take = want - mrunnable;
            mparked  -= std::min(mparked, take);
            mrunnable += take;
        } else {
            mparked += n;
        }
    }

    /** work-stealing slice: parked threads rotate onto idle host lanes and
     *  return to the park set after their quantum, keeping occupancy
     *  host-bound exactly like mttg's round-robin vcpu scheduler. */
    void steal() {
        if (mparked == 0)
            return;
        const auto rotate = std::min(mparked, mhost);
        mparked  -= rotate;
        mrunnable = std::min(mhost, mrunnable + rotate);
        mparked  += rotate; /* they go back after a slice */
        mrunnable = mhost;
    }

    /** @return threads currently parked in the pool */
    [[nodiscard]] std::uint32_t parked() const noexcept { return mparked; }

    /** @return threads currently bound to a host lane */
    [[nodiscard]] std::uint32_t runnable() const noexcept { return mrunnable; }

    /** @return virtual pool divided by host lanes */
    [[nodiscard]] double multiplex() const noexcept {
        return static_cast<double>(mvirtual) /
               static_cast<double>(mhost);
    }

private:
    std::uint32_t mhost;
    std::uint32_t mvirtual;
    std::uint32_t mparked{0};
    std::uint32_t mrunnable{0};
};

} /* namespace vhe::forge */

/* -------------------------------------------------------------------- */
/* build mode 2: nvml + cuda interposition shim (unified-shim pattern)   */
/* -------------------------------------------------------------------- */

#if defined(VHE_BUILD_PRELOAD)

extern "C" {

/* nvml abi surface, trimmed to what pynvml, gpustat and dcgm probe first. */
typedef int           nvmlReturn_t;             /* 0 = NVML_SUCCESS        */
typedef struct nvmlDevice_st* nvmlDevice_t;     /* opaque handle           */
typedef struct { unsigned long long total, used, free; } nvmlMemory_t;
typedef struct { unsigned gpu, memory, encoder, decoder; } nvmlUtilization_t;

#define NVML_SUCCESS          0
#define NVML_ERROR_NOT_FOUND  -9
#define NVML_ERROR_INVALID    -1

/**
 * resolves the real nvml symbol after this object, when a physical driver
 * exists in the process. the unified shim forwards first and fabricates
 * only on absence, exactly like rick-hsu/nvml-unified-shim on DGX hosts.
 * @param name  nvml symbol name
 * @return      real function pointer or nullptr
 */
static void* realsymbol(const char* name) {
    return dlsym(RTLD_NEXT, name);
}

/** returns the active profile key from the environment. */
static std::string shimprofile() {
    return vhe::envstr("VHE_GPU_PROFILE").value_or("a100");
}

/** returns the active device count from the environment. */
static unsigned shimcount() {
    return vhe::envuint("VHE_GPUS", 8, 1, 256);
}

/** maps a fake handle back to its device index (index-as-pointer). */
static unsigned shimindex(nvmlDevice_t device) {
    return device ? static_cast<unsigned>(
                        reinterpret_cast<std::uintptr_t>(device) - 1)
                  : 0;
}

nvmlReturn_t nvmlInit_v2(void) {
    auto real = reinterpret_cast<nvmlReturn_t (*)(void)>(
        realsymbol("nvmlInit_v2"));
    return real ? real() : NVML_SUCCESS;
}

nvmlReturn_t nvmlShutdown(void) {
    auto real =
        reinterpret_cast<nvmlReturn_t (*)(void)>(realsymbol("nvmlShutdown"));
    return real ? real() : NVML_SUCCESS;
}

nvmlReturn_t nvmlSystemGetDriverVersion(char* version,
                                        unsigned int length) {
    if (version == nullptr || length == 0)
        return NVML_ERROR_INVALID;
    std::snprintf(version, length, "%s",
                  vhe::envstr("VHE_SMI_DRIVER").value_or("575.57.08").c_str());
    return NVML_SUCCESS;
}

nvmlReturn_t nvmlSystemGetCudaDriverVersion(int* cudaversion) {
    if (cudaversion == nullptr)
        return NVML_ERROR_INVALID;
    *cudaversion = 12090; /* 1000*major + 10*minor = CUDA 12.9 */
    return NVML_SUCCESS;
}

nvmlReturn_t nvmlDeviceGetCount_v2(unsigned int* count) {
    auto real = reinterpret_cast<nvmlReturn_t (*)(unsigned int*)>(
        realsymbol("nvmlDeviceGetCount_v2"));
    if (real != nullptr)
        return real(count);
    if (count == nullptr)
        return NVML_ERROR_INVALID;
    *count = shimcount();
    return NVML_SUCCESS;
}

nvmlReturn_t nvmlDeviceGetHandleByIndex_v2(unsigned int index,
                                           nvmlDevice_t* device) {
    auto real = reinterpret_cast<nvmlReturn_t (*)(unsigned int,
                                                  nvmlDevice_t*)>(
        realsymbol("nvmlDeviceGetHandleByIndex_v2"));
    if (real != nullptr)
        return real(index, device);
    if (device == nullptr || index >= shimcount())
        return NVML_ERROR_INVALID;
    /* index-as-pointer fake handles, unified-shim style */
    *device = reinterpret_cast<nvmlDevice_t>(
        static_cast<std::uintptr_t>(index + 1));
    return NVML_SUCCESS;
}

nvmlReturn_t nvmlDeviceGetName(nvmlDevice_t device, char* name,
                               unsigned int length) {
    auto real = reinterpret_cast<nvmlReturn_t (*)(nvmlDevice_t, char*,
                                                  unsigned int)>(
        realsymbol("nvmlDeviceGetName"));
    if (real != nullptr)
        return real(device, name, length);
    if (name == nullptr || length == 0)
        return NVML_ERROR_INVALID;
    auto spec = vhe::findspec(shimprofile());
    if (!spec)
        return NVML_ERROR_NOT_FOUND;
    std::snprintf(name, length, "%s", (*spec)->name.data());
    return NVML_SUCCESS;
}

nvmlReturn_t nvmlDeviceGetMemoryInfo(nvmlDevice_t device,
                                     nvmlMemory_t* memory) {
    auto real = reinterpret_cast<nvmlReturn_t (*)(nvmlDevice_t,
                                                  nvmlMemory_t*)>(
        realsymbol("nvmlDeviceGetMemoryInfo"));
    if (real != nullptr)
        return real(device, memory);
    if (memory == nullptr)
        return NVML_ERROR_INVALID;
    auto spec = vhe::findspec(shimprofile());
    if (!spec)
        return NVML_ERROR_NOT_FOUND;
    const unsigned long long total = (*spec)->totalmib << 20; /* MiB to B */
    const unsigned long long used =
        total / 10 +
        vhe::fnv1a((*spec)->name, shimindex(device) + 1) % (total / 20);
    memory->total = total;
    memory->used  = used;
    memory->free  = total - used;
    return NVML_SUCCESS;
}

nvmlReturn_t nvmlDeviceGetPowerManagementLimit(nvmlDevice_t device,
                                               unsigned int* limit) {
    auto real = reinterpret_cast<nvmlReturn_t (*)(nvmlDevice_t,
                                                  unsigned int*)>(
        realsymbol("nvmlDeviceGetPowerManagementLimit"));
    if (real != nullptr)
        return real(device, limit);
    if (limit == nullptr)
        return NVML_ERROR_INVALID;
    auto spec = vhe::findspec(shimprofile());
    if (!spec)
        return NVML_ERROR_NOT_FOUND;
    *limit = (*spec)->powerw * 1000; /* nvml reports milliwatts */
    return NVML_SUCCESS;
}

nvmlReturn_t nvmlDeviceGetTemperature(nvmlDevice_t device, int sensortype,
                                      unsigned int* temp) {
    (void)sensortype; /* only NVML_TEMPERATURE_GPU (0) is emulated */
    auto real = reinterpret_cast<nvmlReturn_t (*)(nvmlDevice_t, int,
                                                  unsigned int*)>(
        realsymbol("nvmlDeviceGetTemperature"));
    if (real != nullptr)
        return real(device, sensortype, temp);
    if (temp == nullptr)
        return NVML_ERROR_INVALID;
    auto spec = vhe::findspec(shimprofile());
    if (!spec)
        return NVML_ERROR_NOT_FOUND;
    *temp = (*spec)->tempc;
    return NVML_SUCCESS;
}

nvmlReturn_t nvmlDeviceGetUtilizationRates(nvmlDevice_t device,
                                           nvmlUtilization_t* util) {
    auto real = reinterpret_cast<nvmlReturn_t (*)(nvmlDevice_t,
                                                  nvmlUtilization_t*)>(
        realsymbol("nvmlDeviceGetUtilizationRates"));
    if (real != nullptr)
        return real(device, util);
    if (util == nullptr)
        return NVML_ERROR_INVALID;
    auto spec = vhe::findspec(shimprofile());
    if (!spec)
        return NVML_ERROR_NOT_FOUND;
    util->gpu = (*spec)->utilpct;
    util->memory = (*spec)->utilpct / 3;
    util->encoder = 0;
    util->decoder = 0;
    return NVML_SUCCESS;
}

nvmlReturn_t nvmlErrorString(nvmlReturn_t result) {
    (void)result;
    return NVML_SUCCESS; /* simplified: callers rarely print shim errors */
}

/* cuda driver api surface, the minimal entry-point set FanBB2333/GpuAdapter
 * intercepts before applications reach libcudart; types follow cuda.h. */
typedef unsigned int CUresult;      /* 0 = CUDA_SUCCESS                  */
typedef int          CUdevice;      /* ordinal                           */

nvmlReturn_t cuInit(unsigned int flags) {
    auto real = reinterpret_cast<CUresult (*)(unsigned int)>(
        realsymbol("cuInit"));
    return real ? static_cast<nvmlReturn_t>(real(flags)) : NVML_SUCCESS;
}

nvmlReturn_t cuDriverGetVersion(int* version) {
    auto real = reinterpret_cast<CUresult (*)(int*)>(
        realsymbol("cuDriverGetVersion"));
    if (real != nullptr)
        return static_cast<nvmlReturn_t>(real(version));
    if (version != nullptr)
        *version = 12090; /* CUDA 12.9 */
    return NVML_SUCCESS;
}

nvmlReturn_t cuDeviceGetCount(int* count) {
    auto real = reinterpret_cast<CUresult (*)(int*)>(
        realsymbol("cuDeviceGetCount"));
    if (real != nullptr)
        return static_cast<nvmlReturn_t>(real(count));
    if (count != nullptr)
        *count = static_cast<int>(shimcount());
    return NVML_SUCCESS;
}

nvmlReturn_t cuDeviceGet(CUdevice* device, int ordinal) {
    auto real = reinterpret_cast<CUresult (*)(CUdevice*, int)>(
        realsymbol("cuDeviceGet"));
    if (real != nullptr)
        return static_cast<nvmlReturn_t>(real(device, ordinal));
    if (device != nullptr && ordinal >= 0 &&
        static_cast<unsigned>(ordinal) < shimcount())
        *device = ordinal;
    return NVML_SUCCESS;
}

nvmlReturn_t cuDeviceGetName(char* name, int len, CUdevice device) {
    auto real = reinterpret_cast<CUresult (*)(char*, int, CUdevice)>(
        realsymbol("cuDeviceGetName"));
    if (real != nullptr)
        return static_cast<nvmlReturn_t>(real(name, len, device));
    if (name == nullptr || len <= 0)
        return NVML_ERROR_INVALID;
    auto spec = vhe::findspec(shimprofile());
    if (!spec)
        return NVML_ERROR_NOT_FOUND;
    std::snprintf(name, static_cast<std::size_t>(len), "%s",
                  (*spec)->name.data());
    return NVML_SUCCESS;
}

nvmlReturn_t cuDeviceTotalMem_v2(std::size_t* bytes, CUdevice device) {
    auto real = reinterpret_cast<CUresult (*)(std::size_t*, CUdevice)>(
        realsymbol("cuDeviceTotalMem_v2"));
    if (real != nullptr)
        return static_cast<nvmlReturn_t>(real(bytes, device));
    if (bytes == nullptr)
        return NVML_ERROR_INVALID;
    auto spec = vhe::findspec(shimprofile());
    if (!spec)
        return NVML_ERROR_NOT_FOUND;
    *bytes = (*spec)->totalmib << 20;
    return NVML_SUCCESS;
}

nvmlReturn_t cuGetErrorString(CUresult error, const char** str) {
    (void)error;
    if (str != nullptr)
        *str = "no error"; /* gpuadapter reports a benign string */
    return NVML_SUCCESS;
}

} /* extern "C" */

#endif /* VHE_BUILD_PRELOAD */

/* -------------------------------------------------------------------- */
/* build mode 3: node 26 native addon (node_api.h)                       */
/* -------------------------------------------------------------------- */

#if defined(VHE_BUILD_ADDON)

/**
 * napi wrapper around rendertable. signature:
 *   generateSmi(profile?: string, gpuCount?: number, opts?: object)
 * opts fields: driver, cuda, mig, csv (booleans/strings).
 * errors surface as napi_throw_error with the spooferror detail, so
 * javascript callers handle failures through try/catch while the c++ side
 * stays exception-free.
 * @param env   napi environment
 * @param info  callback info with the arguments
 * @return      string result or nullptr after throwing
 */
static napi_value generatesmi(napi_env env, napi_callback_info info) {
    std::size_t argc = 3;
    napi_value args[3];
    napi_status status = napi_get_cb_info(env, info, &argc, args, nullptr,
                                          nullptr);
    if (status != napi_ok) {
        napi_throw_error(env, nullptr, "napi: cannot read callback info");
        return nullptr;
    }

    std::string profile = "a100";
    unsigned gpucount = 1;
    std::string driver{vhe::kdriverdefault};
    std::string cuda{vhe::kcudadefault};
    bool mig = false;
    bool csv = false;

    if (argc >= 1 && args[0] != nullptr) {
        std::size_t len = 0;
        if (napi_get_value_string_utf8(env, args[0], nullptr, 0, &len) ==
                napi_ok &&
            len < 64) {
            profile.assign(len + 1, '\0');
            napi_get_value_string_utf8(env, args[0], profile.data(), len + 1,
                                       &len);
            profile.resize(len);
        }
    }
    if (argc >= 2 && args[1] != nullptr) {
        std::uint32_t n = 1;
        if (napi_get_value_uint32(env, args[1], &n) == napi_ok)
            gpucount = n;
    }
    if (argc >= 3 && args[2] != nullptr) {
        napi_value value;
        if (napi_get_named_property(env, args[2], "driver", &value) ==
                napi_ok &&
            value != nullptr) {
            std::size_t len = 0;
            if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) ==
                    napi_ok &&
                len < 32) {
                driver.assign(len + 1, '\0');
                napi_get_value_string_utf8(env, value, driver.data(), len + 1,
                                           &len);
                driver.resize(len);
            }
        }
        if (napi_get_named_property(env, args[2], "cuda", &value) == napi_ok &&
            value != nullptr) {
            std::size_t len = 0;
            if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) ==
                    napi_ok &&
                len < 32) {
                cuda.assign(len + 1, '\0');
                napi_get_value_string_utf8(env, value, cuda.data(), len + 1,
                                           &len);
                cuda.resize(len);
            }
        }
        bool flag = false;
        if (napi_get_named_property(env, args[2], "mig", &value) == napi_ok &&
            value != nullptr &&
            napi_get_value_bool(env, value, &flag) == napi_ok)
            mig = flag;
        if (napi_get_named_property(env, args[2], "csv", &value) == napi_ok &&
            value != nullptr &&
            napi_get_value_bool(env, value, &flag) == napi_ok)
            csv = flag;
    }

    vhe::smiresult result =
        csv ? vhe::renderquerycsv(profile, gpucount, vhe::kqueryfields,
                                    false, driver, cuda)
            : vhe::rendertable(profile, gpucount, driver, cuda, mig);
    if (!result) {
        napi_throw_error(env, nullptr, result.error().detail.c_str());
        return nullptr;
    }
    napi_value out;
    status = napi_create_string_utf8(env, result->c_str(), result->size(),
                                     &out);
    if (status != napi_ok) {
        napi_throw_error(env, nullptr, "napi: cannot create result string");
        return nullptr;
    }
    return out;
}

/** module registration: exports generateSmi plus identity metadata. */
static napi_value moduleinit(napi_env env, napi_value exports) {
    napi_value fn;
    if (napi_create_function(env, "generateSmi", NAPI_AUTO_LENGTH,
                             generatesmi, nullptr, &fn) == napi_ok)
        napi_set_named_property(env, exports, "generateSmi", fn);

    napi_value driver;
    if (napi_create_string_utf8(env, vhe::kdriverdefault.data(),
                                vhe::kdriverdefault.size(),
                                &driver) == napi_ok)
        napi_set_named_property(env, exports, "driverVersion", driver);

    napi_value cuda;
    if (napi_create_string_utf8(env, vhe::kcudadefault.data(),
                                vhe::kcudadefault.size(), &cuda) == napi_ok)
        napi_set_named_property(env, exports, "cudaVersion", cuda);

    napi_value width;
    if (napi_create_uint32(env, static_cast<std::uint32_t>(vhe::ktable),
                           &width) == napi_ok)
        napi_set_named_property(env, exports, "tableWidth", width);

    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, moduleinit)

#endif /* VHE_BUILD_ADDON */

/* -------------------------------------------------------------------- */
/* build mode 1: the virtual nvidia-smi adapter command line                        */
/* -------------------------------------------------------------------- */

#if defined(VHE_BUILD_CLI)

/**
 * prints a short usage block; mirrors nvidia-smi --help spirit without
 * pretending to support the full flag surface.
 */
static void printusage() {
    std::println("nvidia-smi (virtual hardware engine v5 virtual identity)");
    std::println("usage: nvidia-smi [profile] [count] [options]");
    std::println("  options:");
    std::println("    -L, --list-gpus            list devices with uuids");
    std::println("    --query-gpu=FIELDS -f csv  csv query mode");
    std::println("    --format=csv,noheader      csv without header line");
    std::println("  environment: VHE_GPU_PROFILE, VHE_GPUS, VHE_SMI_DRIVER,");
    std::println("               VHE_SMI_CUDA, VHE_MIG, VHE_DEBUG");
}

/**
 * entry point: argument parsing with std::expected error propagation and
 * exit codes 0 (ok), 1 (render failure), 2 (usage failure).
 */
int main(int argc, char** argv) {
    std::string profile =
        vhe::envstr("VHE_GPU_PROFILE").value_or("a100");
    unsigned gpucount = vhe::envuint("VHE_GPUS", 8, 1, 256);
    std::string driver = vhe::envstr("VHE_SMI_DRIVER").value_or("575.57.08");
    std::string cuda   = vhe::envstr("VHE_SMI_CUDA").value_or("12.9");
    std::string queryfields; /* filled from --query-gpu=... */
    bool listgpus = false;
    bool querycsv = false;
    bool noheader = false;
    bool mig = vhe::envuint("VHE_MIG", 0, 0, 1) != 0;

    for (int i = 1; i < argc; ++i) {
        std::string_view arg{argv[i]};
        if (arg == "-L" || arg == "--list-gpus") {
            listgpus = true;
        } else if (arg.starts_with("--query-gpu=")) {
            querycsv = true;
            queryfields = std::string{
                arg.substr(std::string_view{"--query-gpu="}.size())};
        } else if (arg == "-f" || arg == "--format" ||
                   arg.starts_with("--format=")) {
            std::string_view fmtspec =
                arg.starts_with("--format=")
                    ? arg.substr(std::string_view("--format=").size())
                    : (i + 1 < argc ? std::string_view{argv[++i]}
                                    : std::string_view{"csv"});
            if (fmtspec.find("noheader") != std::string_view::npos)
                noheader = true;
        } else if (arg == "--help" || arg == "-h") {
            printusage();
            return 0;
        } else if (!arg.empty() && arg[0] != '-') {
            /* positional: first is profile, second is count */
            auto probe = vhe::findspec(arg);
            if (probe) {
                profile = std::string{arg};
            } else {
                try {
                    unsigned n =
                        static_cast<unsigned>(std::stoul(std::string{arg}));
                    if (n >= 1 && n <= 256)
                        gpucount = n;
                } catch (...) {
                    std::println(stderr,
                                 "nvidia-smi: unrecognized argument '{}'",
                                 arg);
                    printusage();
                    return 2;
                }
            }
        } else {
            std::println(stderr, "nvidia-smi: unsupported flag '{}'", arg);
            printusage();
            return 2;
        }
    }

    vhe::smiresult result;
    if (listgpus) {
        result = vhe::renderdevicelist(profile, gpucount);
    } else if (querycsv) {
        result = vhe::renderquerycsv(profile, gpucount, queryfields,
                                       noheader, driver, cuda);
    } else {
        result = vhe::rendertable(profile, gpucount, driver, cuda, mig);
    }

    if (!result) {
        std::println(stderr, "nvidia-smi: {}", result.error().detail);
        return 1;
    }
    std::print("{}", *result);
    return 0;
}

#endif /* VHE_BUILD_CLI */

/* -------------------------------------------------------------------- */
/* build mode 4: the aetherforge plan compiler                            */
/* -------------------------------------------------------------------- */

#if defined(VHE_BUILD_FORGE)

/**
 * prints a short usage block for the forge mode; the three flags cover the
 * dimensions operators tune per lab (vcpus, mttg pool, guest memory).
 */
static void printforgeusage() {
    std::println("aetherforge — emit a qemu 11.1.0 plan");
    std::println("usage: aetherforge [--smp N] [--mttg N] [--mem GIB]");
    std::println("  --smp N   vcpus presented to the guest");
    std::println("  --mttg N  virtual threads in the mttg pool");
    std::println("  --mem N   guest memory in GiB");
}

/**
 * forge entry point: parses the three tuning flags, validates the plan
 * through the same expected<Plan, Err> channel the library exposes, prints
 * the mttg multiplex summary line and the fully quoted qemu command.
 * malformed numbers are caught and reported instead of aborting.
 */
int main(int argc, char** argv) {
    vhe::forge::Plan plan{};
    if (argc > 1 && std::string_view{argv[1]} == "--help") {
        printforgeusage();
        return 0;
    }
    for (int i = 1; i + 1 < argc; ++i) {
        const std::string_view k{argv[i]};
        const std::string_view v{argv[i + 1]};
        if (k != "--smp" && k != "--mttg" && k != "--mem")
            continue;
        unsigned parsed = 0;
        try {
            parsed = static_cast<unsigned>(std::stoul(std::string{v}));
        } catch (...) {
            std::println(stderr, "aetherforge: unparsable value '{}' for {}",
                         v, k);
            return 2;
        }
        if (k == "--smp") {
            plan.vcpus = parsed;
        } else if (k == "--mttg") {
            plan.mttg = true;
            plan.mttgthreads = parsed;
        } else {
            plan.memorygib = parsed;
        }
        ++i; /* the value token is consumed */
    }
    auto ok = vhe::forge::validate(std::move(plan));
    if (!ok) {
        std::println(stderr, "aetherforge: invalid plan (error {})",
                     static_cast<unsigned>(ok.error()));
        return 1;
    }
    const auto host = std::max(
        1u, static_cast<unsigned>(std::thread::hardware_concurrency()));
    vhe::forge::Mttg grid{host, ok->mttgthreads};
    grid.steal();
    std::println("# host threads {}  virtual {}  multiplex {:.1f}x", host,
                 ok->mttgthreads, grid.multiplex());
    std::println("{}\n", vhe::forge::qemucommand(*ok));
    return 0;
}

#endif /* VHE_BUILD_FORGE */
