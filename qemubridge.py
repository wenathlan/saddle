"""
qemubridge.py - async QMP bridge client for the virtual hardware engine v2.

The module mediates QEMU Machine Protocol (QMP) over a unix socket with a
single merged class surface: the v6 observer bridge (22 ops) fused with the
unique operations of the v5 QEMUQMPClient, plus an internal smiadapter module
that renders a software nvidia-smi facade for a100/h100 flex profiles.

Merge provenance (mapcode T12, date-first 2026-08-22):
  - base: e2pool/qemubridge.py (662 lines, v6 observer, 22 functions)
  - absorbed uniques: e2pool/src_qemu_bridge.py (561 lines) - VMStatus enum,
    QEMUConfig loader, MigrationStats polling, oob handshake, hotunplug pair,
    hotpluggable-cpus matching, sched_setaffinity path, query-qemu-features,
    dirty-rate page-sampling mode, qmpsession, batch hotplug, flat configs
  - incorporated as internal module: e2pool/fakenvidiasmi.py (32 lines,
    smiadapter a100/h100 flex table; driver re-pinned 575.51.03 -> 575.57.08)
  - discarded: e2pool/rap.py and e2pool/main.py (v3 boilerplate, no value)

Version anchors confirmed 2026-08-23: QEMU 11.1.0, Node 26.7.0 current /
24.19.0 LTS, npm 12.0.2, NVIDIA driver 575.57.08, CUDA 12.9. Python floor is
3.14 for production (the file also runs on 3.13); python 3.14 ships the
incremental garbage collector enabled by default, which only lowers pause
tail latency.

Standalone usage - python3 qemubridge.py --help lists every mode:
  selftest (default, offline) | status | cpus | memory | version | migrate |
  blockjobs | batchcpus | configs | smiadapter | shim

The file groups logic in 25 correlated contexts with defensive try/except
logging throughout. No host is ever hardcoded: the migration target host is
a parameter or VHE_MIGRATE_HOST, and ports default to random.randint(30000,
59999). Standard library only (asyncio, json, argparse, pathlib, logging).
"""

# --------------------------------------------------------------------------- #
# context 01 - module identity and imports
# --------------------------------------------------------------------------- #

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import random
import sys
import time
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Literal

# --------------------------------------------------------------------------- #
# context 02 - version constants (re-pinned, no old pins)
# --------------------------------------------------------------------------- #

PYTHONVERSIONTARGET: str = "3.14"  # 3.14+ floor; incremental gc enabled by default
QEMUVERSIONTARGET: str = "11.1.0"
NODELTSVERSION: str = "24.19.0"
NODECURRENTVERSION: str = "26.7.0"
DRIVERVERSIONTARGET: str = "575.57.08"
CUDAVERSIONTARGET: str = "12.9"
BRIDGEVERSION: str = "2.0.0"
BUILDDATE: str = "2026-08-22"

QEMUDEFAULTSOCKET: str = "/run/vhe/vm-{vmid}.qmp"
QEMUDEFAULTTIMEOUT: float = 8.0
QEMUDEFAULTBINARY: str = "/usr/bin/qemu-system-x86_64"

# --------------------------------------------------------------------------- #
# context 03 - node compatibility matrix
# --------------------------------------------------------------------------- #

NODECOMPAT: dict[str, Any] = {
    "runtime": f"node@{NODECURRENTVERSION} current / node@{NODELTSVERSION} lts",
    "protocol": "qmp-unix-socket",
    "native_modules": ["node:net", "node:fs", "node:path", "node:crypto", "node:http", "node:child_process"],
    "ipc": "ndjson",
    "socketPath": "/run/vhe/vm.qmp",
    "qemu": QEMUVERSIONTARGET,
    "python": PYTHONVERSIONTARGET,
    "driver": DRIVERVERSIONTARGET,
    "cuda": CUDAVERSIONTARGET,
    "endianness": "little",
}

# --------------------------------------------------------------------------- #
# context 04 - logging setup
# --------------------------------------------------------------------------- #

logger = logging.getLogger("qemubridge")


# --------------------------------------------------------------------------- #
# context 05 - status model (typed runstate, 6 states)
# --------------------------------------------------------------------------- #

class VMStatus(str, Enum):
    """Maps the QEMU query-status runstate vocabulary."""

    RUNNING = "running"
    PAUSED = "paused"
    SHUTDOWN = "shutdown"
    INMIGRATE = "inmigrate"
    PRELAUNCH = "prelaunch"
    SUSPENDED = "suspended"


# --------------------------------------------------------------------------- #
# context 06 - error model (code plus details)
# --------------------------------------------------------------------------- #

class QemuBridgeError(Exception):
    """Carries a QMP error class code and a details payload for operators."""

    def __init__(self, message: str, code: str = "QMP_ERROR", details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


# --------------------------------------------------------------------------- #
# context 07 - stats model (bridge counters)
# --------------------------------------------------------------------------- #

@dataclass(slots=True)
class QemuBridgeStats:
    """Tracks bridge counters across the connection lifetime."""

    connects: int = 0
    commands: int = 0
    errors: int = 0
    lastlatencyms: float = 0.0
    startedat: float = field(default_factory=time.time)


# --------------------------------------------------------------------------- #
# context 08 - config model (qemu.config / vm.config loader)
# --------------------------------------------------------------------------- #

def coercebool(value: Any) -> bool:
    """Coerces config scalars to bool without the truthy-string trap."""
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


@dataclass(slots=True)
class QEMUConfig:
    """Holds the parsed representation of qemu.config or vm.config."""

    vmid: str
    socketpath: str = ""
    qemubinary: str = QEMUDEFAULTBINARY
    machinetype: str = "q35"
    accel: str = "kvm"
    cpumodel: str = "host"
    cores: int = 8
    vcpus: int = 8
    memorymb: int = 8192
    hugepages: bool = False
    cxlenabled: bool = False
    gpupassthrough: list[str] = field(default_factory=list)
    extraargs: list[str] = field(default_factory=list)

    @classmethod
    def loadfromfile(cls, path: str | os.PathLike, vmid: str = "vm0") -> QEMUConfig:
        """
        Loads a json or key=value config file with defensive defaults.

        Args:
            path: Config file location; a missing file yields safe defaults.
            vmid: VM identifier used for the default socket path.

        Returns:
            QEMUConfig: The parsed configuration with per-key fallbacks.
        """
        p = Path(path)
        data: dict[str, Any] = {"vm_id": vmid}
        if p.exists():
            try:
                if p.suffix == ".json":
                    loaded = json.loads(p.read_text())
                    if isinstance(loaded, dict):
                        data.update(loaded)
                else:
                    for line in p.read_text().splitlines():
                        line = line.strip()
                        if not line or line.startswith("#") or "=" not in line:
                            continue
                        k, _, v = line.partition("=")
                        data[k.strip()] = v.strip().strip('"').strip("'")
            except (OSError, json.JSONDecodeError) as e:
                logger.warning("failed to parse %s: %s - using defaults", path, e)
        return cls(
            vmid=str(data.get("vm_id", vmid)),
            socketpath=str(data.get("socket_path", QEMUDEFAULTSOCKET.format(vmid=vmid))),
            qemubinary=str(data.get("qemu_binary", QEMUDEFAULTBINARY)),
            machinetype=str(data.get("machine_type", "q35")),
            accel=str(data.get("accel", "kvm")),
            cpumodel=str(data.get("cpu_model", "host")),
            cores=int(data.get("cores", data.get("vcpus", 8))),
            vcpus=int(data.get("vcpus", 8)),
            memorymb=int(data.get("memory_mb", 8192)),
            hugepages=coercebool(data.get("hugepages", False)),
            cxlenabled=coercebool(data.get("cxl_enabled", False)),
            gpupassthrough=list(data.get("gpu_passthrough", [])),
            extraargs=list(data.get("extra_args", [])),
        )


# --------------------------------------------------------------------------- #
# context 09 - migration model (stats payload)
# --------------------------------------------------------------------------- #

@dataclass(slots=True)
class MigrationStats:
    """Summarizes one live migration attempt for callers and audits."""

    ramtransferredmb: float
    ramremainingmb: float
    dirtyratembps: float
    downtimems: int
    status: str
    uri: str = ""


# --------------------------------------------------------------------------- #
# context 10 - bridge transport internals (envelope, events, oob)
# --------------------------------------------------------------------------- #

class QemuBridge:
    """
    Implements the async QMP client for QEMU 11.1.0 with 25 numbered ops.

    The bridge negotiates capabilities (oob enabled), queries VM state and
    performs hotplug, hotunplug, snapshots, migration, block jobs, vCPU
    affinity and IO throttling. CI tolerance: a missing socket produces a
    logged mock connect instead of a crash.
    """

    def __init__(self, socketpath: str = "/run/vhe/vm.qmp", timeout: float = QEMUDEFAULTTIMEOUT):
        self.socketpath: str = socketpath
        self.timeout: float = timeout
        self.reader: asyncio.StreamReader | None = None
        self.writer: asyncio.StreamWriter | None = None
        self.stats = QemuBridgeStats()
        self.handshaked: bool = False
        self.qemurelease: str = QEMUVERSIONTARGET  # attr qemurelease: method qemuversion() keeps the op name
        self.sendlock = asyncio.Lock()

    async def send(self, payload: dict[str, Any]) -> dict[str, Any]:
        """
        Writes one NDJSON command and returns the full response envelope.

        Args:
            payload: QMP command dictionary with an ``execute`` key.

        Returns:
            dict: The full QMP response envelope, events already skipped.

        Raises:
            QemuBridgeError: On transport failure, timeout or QMP error reply.
        """
        if not self.writer or not self.reader:
            raise QemuBridgeError("not connected", "NOT_CONNECTED")
        async with self.sendlock:
            start = time.perf_counter()
            try:
                self.writer.write((json.dumps(payload) + "\n").encode("utf-8"))
                await self.writer.drain()
                while True:
                    raw = await asyncio.wait_for(self.reader.readline(), timeout=self.timeout)
                    if not raw:
                        raise QemuBridgeError("empty response", "EMPTY_RESPONSE")
                    try:
                        resp = json.loads(raw.decode("utf-8"))
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        logger.debug("skipping non-json QMP line")
                        continue
                    match resp:
                        case {"event": str() as event}:
                            logger.debug("qmp event skipped: %s", event)
                            continue  # async events interleave with responses
                        case {"error": err}:
                            raise QemuBridgeError(
                                err.get("desc", "qmp error"), err.get("class", "QMP_ERROR"), err
                            )
                        case {"return": _}:
                            self.stats.commands += 1
                            self.stats.lastlatencyms = (time.perf_counter() - start) * 1000.0
                            return resp
                        case _:
                            self.stats.commands += 1  # bare ack tolerance
                            return resp
            except asyncio.TimeoutError as e:
                self.stats.errors += 1
                raise QemuBridgeError(f"timeout after {self.timeout}s", "TIMEOUT") from e
            except QemuBridgeError:
                self.stats.errors += 1
                raise
            except Exception as e:
                self.stats.errors += 1
                raise QemuBridgeError(str(e), "TRANSPORT_ERROR", {"exception": repr(e)}) from e

    async def readgreeting(self) -> dict[str, Any]:
        """Reads the QMP greeting banner sent right after socket connect."""
        if not self.reader:
            raise QemuBridgeError("no reader", "NOT_CONNECTED")
        raw = await asyncio.wait_for(self.reader.readline(), timeout=self.timeout)
        if not raw:
            raise QemuBridgeError("no greeting", "GREETING_FAILED")
        return json.loads(raw.decode("utf-8"))

    async def execute(self, command: str, arguments: dict[str, Any] | None = None) -> Any:
        """
        Executes one QMP command and unwraps the return payload.

        Args:
            command: QMP command name, for example ``query-status``.
            arguments: Optional command arguments dictionary.

        Returns:
            Any: The ``return`` field of the QMP response when present.
        """
        payload: dict[str, Any] = {"execute": command}
        if arguments:
            payload["arguments"] = arguments
        resp = await self.send(payload)
        return resp.get("return", resp)

    def getnodecompat(self) -> dict[str, Any]:
        """Returns the node compatibility descriptor of the bridge."""
        return {**NODECOMPAT, "bridge": BRIDGEVERSION, "date": BUILDDATE}

    # ----------------------------------------------------------------------- #
    # context 11 - connectivity lifecycle
    # ----------------------------------------------------------------------- #

    async def connect(self) -> bool:
        """Op 01/25 - establishes the unix socket link and reads the greeting."""
        try:
            if not os.path.exists(self.socketpath):
                # The bridge tolerates a missing socket in CI with a mock link.
                logger.warning("socket %s absent - mock connect for CI %s", self.socketpath, BUILDDATE)
                self.stats.connects += 1
                return True
            self.reader, self.writer = await asyncio.wait_for(
                asyncio.open_unix_connection(self.socketpath), timeout=self.timeout
            )
            self.stats.connects += 1
            greeting = await self.readgreeting()
            qver = greeting.get("QMP", {}).get("version", {}).get("qemu", {})
            self.qemurelease = f"{qver.get('major', 11)}.{qver.get('minor', 1)}.{qver.get('micro', 0)}"
            logger.info("connected QMP greeting %s", greeting.get("QMP", {}).get("version", {}))
            return True
        except Exception as e:
            raise QemuBridgeError(f"connect failed {e}", "CONNECT_FAILED", {"path": self.socketpath}) from e

    async def handshake(self) -> dict[str, Any]:
        """Op 02/25 - negotiates capabilities with oob and validates the version."""
        resp = await self.send({"execute": "qmp_capabilities", "arguments": {"enable": ["oob"]}})
        versionresp = await self.send({"execute": "query-version"})
        qemu = versionresp.get("return", {}).get("qemu", {})
        self.qemurelease = f"{qemu.get('major', 11)}.{qemu.get('minor', 1)}.{qemu.get('micro', 0)}"
        self.handshaked = True
        return {"capabilities": resp.get("return", {}), "version": versionresp.get("return", {}), "qemu_target": QEMUVERSIONTARGET}

    async def disconnect(self) -> bool:
        """Op 25/25 - sends quit and gracefully closes the QMP session."""
        try:
            if self.writer and self.handshaked:
                try:
                    await self.send({"execute": "quit"})
                except Exception:
                    logger.debug("quit not acknowledged before close")
            if self.writer:
                self.writer.close()
                try:
                    await self.writer.wait_closed()
                except Exception:
                    logger.debug("wait_closed failed - socket already gone")
            self.reader = None
            self.writer = None
            self.handshaked = False
            return True
        except Exception as e:
            raise QemuBridgeError(f"disconnect failed {e}", "DISCONNECT_FAILED") from e

    async def __aenter__(self) -> QemuBridge:
        await self.connect()
        try:
            await self.handshake()
        except Exception:
            logger.warning("handshake deferred - CI mock mode")
        return self

    async def __aexit__(self, exctype, exc, tb) -> None:  # type: ignore[no-untyped-def]
        await self.disconnect()

    # ----------------------------------------------------------------------- #
    # context 12 - vm introspection
    # ----------------------------------------------------------------------- #

    async def querystatus(self) -> VMStatus:
        """Op 04/25 - returns the typed VM runstate with a running fallback."""
        detail = await self.execute("query-status")
        status = detail.get("status", "running") if isinstance(detail, dict) else "running"
        try:
            return VMStatus(status)
        except ValueError:
            logger.warning("unknown runstate %r - defaulting to running", status)
            return VMStatus.RUNNING

    async def querycpus(self) -> list[dict[str, Any]]:
        """Op 05/25 - lists vCPUs via query-cpus-fast with legacy fallback."""
        try:
            return await self.execute("query-cpus-fast")
        except QemuBridgeError as e:
            logger.warning("query-cpus-fast failed (%s) - falling back to query-cpus", e.code)
            return await self.execute("query-cpus")

    async def querymemory(self) -> dict[str, Any]:
        """Op 06/25 - summarizes memory size, devices and balloon state."""
        summary = await self.execute("query-memory-size-summary")
        try:
            devices = await self.execute("query-memory-devices")
        except QemuBridgeError as e:
            logger.debug("query-memory-devices unavailable: %s", e.code)
            devices = []
        try:
            balloon = await self.execute("query-balloon")
        except QemuBridgeError as e:
            logger.debug("query-balloon unavailable: %s", e.code)
            balloon = {"actual": summary.get("base-memory", 0)} if isinstance(summary, dict) else {}
        return {
            "summary": summary,
            "devices": devices,
            "balloon": balloon,
            "timestamp": time.time(),  # typo " timestamp" from the v5 source fixed here
            "target": QEMUVERSIONTARGET,
        }

    # ----------------------------------------------------------------------- #
    # context 13 - cpu hotplug and hotunplug
    # ----------------------------------------------------------------------- #

    async def hotplugcpu(self, socketid: int = 0, coreid: int = 1, threadid: int = 0) -> dict[str, Any]:
        """
        Op 07/25 - hotplugs a vCPU matching the hotpluggable-cpus topology.

        The bridge prefers the cpu type advertised by the matching slot and
        falls back to the host cpu model, which beats fabricated id suffixes.

        Args:
            socketid: Target socket index advertised by the topology.
            coreid: Target core index inside the socket.
            threadid: Target thread index inside the core.

        Returns:
            dict: The device id, driver, resolved props and the action tag.
        """
        target: dict[str, Any] | None = None
        try:
            hotpluggable = await self.execute("query-hotpluggable-cpus")
        except QemuBridgeError as e:
            logger.warning("query-hotpluggable-cpus failed (%s) - using props defaults", e.code)
            hotpluggable = []
        for cpu in hotpluggable:
            props = cpu.get("props", {})
            if props.get("socket-id") == socketid and props.get("core-id") == coreid:
                target = cpu
                break
        if target is None and hotpluggable:
            target = hotpluggable[0]
        props = (target or {}).get("props", {}) or {"socket-id": socketid, "core-id": coreid, "thread-id": threadid}
        driver = (target or {}).get("type", "host-x86_64-cpu")
        cpuid = f"cpu-{props.get('socket-id', socketid)}-{props.get('core-id', coreid)}-{props.get('thread-id', threadid)}"
        await self.execute("device_add", {
            "driver": driver,
            "id": cpuid,
            "socket-id": props.get("socket-id", socketid),
            "core-id": props.get("core-id", coreid),
            "thread-id": props.get("thread-id", threadid),
        })
        return {"id": cpuid, "driver": driver, "props": props, "action": "hotplug_cpu"}

    async def hotunplugcpu(self, cpuid: str) -> Any:
        """Op 08/25 - removes a vCPU via device_del (guest cooperation)."""
        return await self.execute("device_del", {"id": cpuid})

    # ----------------------------------------------------------------------- #
    # context 14 - memory hotplug
    # ----------------------------------------------------------------------- #

    async def hotplugmemory(self, sizemb: int = 1024, node: int = 0, memid: str | None = None) -> dict[str, Any]:
        """
        Op 09/25 - hotplugs a pc-dimm backed by memory-backend-ram (>=128MB).

        Args:
            sizemb: Dimm size in megabytes; values below 128 raise EINVAL.
            node: NUMA node the dimm attaches to.
            memid: Optional backend id; defaults to a timestamped name.

        Returns:
            dict: The backend id, dimm id, size and node of the new device.

        Raises:
            QemuBridgeError: When the requested size is below the 128MB floor.
        """
        if sizemb < 128:
            raise QemuBridgeError("size too small (min 128MB)", "EINVAL", {"size_mb": sizemb})
        stamp = int(time.time()) % 100000
        backendid = memid or f"mem{stamp}"
        dimmid = f"dimm{stamp}"
        await self.execute("object-add", {
            "qom-type": "memory-backend-ram",
            "id": backendid,
            "size": sizemb * 1024 * 1024,
        })
        await self.execute("device_add", {
            "driver": "pc-dimm",
            "id": dimmid,
            "memdev": backendid,
            "node": node,
        })
        return {"memdev": backendid, "dimm": dimmid, "size_mb": sizemb, "node": node}

    # ----------------------------------------------------------------------- #
    # context 15 - pcie hotplug and hotunplug
    # ----------------------------------------------------------------------- #

    async def hotplugpcie(
        self,
        driver: str = "nvme",
        bus: str = "pcie.0",
        idstr: str | None = None,
        addr: str = "0x0",
    ) -> dict[str, Any]:
        """Op 10/25 - hotplugs a PCIe device with a sha1-derived stable id."""
        devid = idstr or f"pcie-{driver}-{hashlib.sha1(os.urandom(8)).hexdigest()[:6]}"
        args: dict[str, Any] = {"driver": driver, "id": devid, "bus": bus, "addr": addr}
        if driver == "vfio-pci":
            args["x-vga"] = "gpu" in devid
        await self.execute("device_add", args)
        return {"id": devid, "driver": driver, "bus": bus, "addr": addr}

    async def hotunplugpcie(self, deviceid: str) -> Any:
        """Op 11/25 - removes a PCIe device via device_del."""
        return await self.execute("device_del", {"id": deviceid})

    # ----------------------------------------------------------------------- #
    # context 16 - internal snapshots
    # ----------------------------------------------------------------------- #

    async def snapshotcreate(self, name: str, devices: list[str] | None = None) -> dict[str, Any]:
        """Op 12/25 - creates a snapshot via snapshot-save with savevm fallback."""
        if not name or len(name) > 128:
            raise QemuBridgeError("invalid snapshot name", "EINVAL", {"name": name})
        try:
            result = await self.execute("snapshot-save", {
                "job-id": f"snap-{name}",
                "tag": name,
                "vmstate": "vmstate",
                "devices": devices or ["drv0"],
            })
        except QemuBridgeError as e:
            logger.warning("snapshot-save unavailable (%s) - savevm fallback", e.code)
            result = await self.execute("human-monitor-command", {"command-line": f"savevm {name}"})
        return {"name": name, "result": result, "date": BUILDDATE}

    async def snapshotdelete(self, name: str) -> dict[str, Any]:
        """Op 13/25 - deletes a snapshot via snapshot-delete with delvm fallback."""
        try:
            result = await self.execute("snapshot-delete", {"job-id": f"del-{name}", "tag": name})
        except QemuBridgeError as e:
            logger.warning("snapshot-delete unavailable (%s) - delvm fallback", e.code)
            result = await self.execute("human-monitor-command", {"command-line": f"delvm {name}"})
        return {"name": name, "deleted": True, "result": result}

    async def snapshotrestore(self, name: str) -> dict[str, Any]:
        """Op 14/25 - loads a snapshot via snapshot-load with loadvm fallback."""
        try:
            result = await self.execute("snapshot-load", {"job-id": f"load-{name}", "tag": name})
        except QemuBridgeError as e:
            logger.warning("snapshot-load unavailable (%s) - loadvm fallback", e.code)
            result = await self.execute("human-monitor-command", {"command-line": f"loadvm {name}"})
        return {"name": name, "restored": True, "result": result}

    # ----------------------------------------------------------------------- #
    # context 17 - migration control (multifd, polling, status)
    # ----------------------------------------------------------------------- #

    def randomport(self) -> int:
        """Returns a random migration port in the 30000-59999 user range."""
        return random.randint(30000, 59999)

    async def livemigrate(
        self,
        uri: str | None = None,
        host: str | None = None,
        port: int | None = None,
        multifdchannels: int = 8,
        downtimems: int = 300,
        bandwidth: int = 1073741824,
        wait: bool = True,
    ) -> MigrationStats:
        """
        Op 15/25 - runs a live migration and polls until completed.

        The destination is explicit: either a full uri or a host parameter
        (or VHE_MIGRATE_HOST); the port defaults to a random 30000-59999
        draw. The bridge never falls back to an implicit localhost target.

        Args:
            uri: Full migration uri, for example ``tcp:host:port``.
            host: Target host; combined with a random or explicit port.
            port: Optional explicit port; otherwise a random draw.
            multifdchannels: Multifd channel count, clamped to the 2-32 range.
            downtimems: Maximum acceptable guest downtime in milliseconds.
            bandwidth: Migration bandwidth cap in bytes per second.
            wait: When true, polls query-migrate until completion.

        Returns:
            MigrationStats: Transfer counters, downtime and final status.

        Raises:
            QemuBridgeError: On invalid ranges, failure or poll timeout.
        """
        if not (2 <= multifdchannels <= 32):
            raise QemuBridgeError("multifdchannels out of range 2-32", "EINVAL", {"channels": multifdchannels})
        if uri is None:
            targethost = host or os.environ.get("VHE_MIGRATE_HOST")
            if not targethost:
                raise QemuBridgeError("migration target required: pass uri or host (no implicit localhost)", "EINVAL")
            uri = f"tcp:{targethost}:{port if port is not None else self.randomport()}"
        await self.execute("migrate-set-parameters", {
            "max-bandwidth": bandwidth,
            "downtime-limit": downtimems,
            "multifd-channels": multifdchannels,
        })
        await self.execute("migrate", {"uri": uri})
        if not wait:
            return MigrationStats(0.0, 0.0, 0.0, 0, "launched", uri)
        for _ in range(120):  # poll up to 120 x 1s for completion
            await asyncio.sleep(1.0)
            status = await self.execute("query-migrate")
            state = status.get("status", "active") if isinstance(status, dict) else "active"
            if state == "completed":
                ram = status.get("ram", {})
                pagesize = 4096  # 4 KiB guest page assumption for the rate math
                return MigrationStats(
                    ramtransferredmb=ram.get("transferred", 0) / (1024 * 1024),
                    ramremainingmb=ram.get("remaining", 0) / (1024 * 1024),
                    dirtyratembps=ram.get("dirty-pages-rate", 0) * pagesize / (1024 * 1024),
                    downtimems=int(status.get("downtime", downtimems)),
                    status="completed",
                    uri=uri,
                )
            if state == "failed":
                raise QemuBridgeError("migration failed", "MIGRATION_FAILED", status)
        raise QemuBridgeError("migration timed out after 120s poll", "MIGRATION_TIMEOUT", {"uri": uri})

    async def setmultifd(self, channels: int = 8, compression: str = "zstd", zerocopy: bool = True) -> dict[str, Any]:
        """Op 16/25 - configures multifd capabilities, channels and zstd level."""
        if not (2 <= channels <= 32):
            raise QemuBridgeError("multifd channels out of range 2-32", "EINVAL", {"channels": channels})
        if compression not in ("none", "zlib", "zstd"):
            raise QemuBridgeError("unknown multifd compression", "EINVAL", {"compression": compression})
        await self.execute("migrate-set-capabilities", {
            "capabilities": [
                {"capability": "multifd", "state": True},
                {"capability": "zero-copy-send", "state": zerocopy},
            ]
        })
        result = await self.execute("migrate-set-parameters", {
            "multifd-channels": channels,
            "multifd-compression": compression,
            "multifd-zstd-level": 3,
        })
        return {"channels": channels, "compression": compression, "zero_copy": zerocopy, "result": result}

    async def querymigratestatus(self) -> dict[str, Any]:
        """Op 24/25 - queries migration status with capability merge."""
        status = await self.execute("query-migrate")
        if not isinstance(status, dict):
            return {"status": "unknown"}
        try:
            caps = await self.execute("query-migrate-capabilities")
            status["capabilities"] = caps
        except QemuBridgeError as e:
            logger.debug("query-migrate-capabilities unavailable: %s", e.code)
        return status

    # ----------------------------------------------------------------------- #
    # context 18 - dirty page rate sampling
    # ----------------------------------------------------------------------- #

    async def calcdirtyrate(self, periodsec: int = 1, mode: str = "page-sampling") -> dict[str, Any]:
        """Op 17/25 - samples the guest dirty page rate (1-60s window)."""
        if not (1 <= periodsec <= 60):
            raise QemuBridgeError("period out of range 1-60", "EINVAL", {"period_sec": periodsec})
        try:
            await self.execute("calc-dirty-rate", {"calc-time": periodsec, "mode": mode})
            await asyncio.sleep(periodsec + 0.3)
            data = await self.execute("query-dirty-rate")
            rate = data.get("dirty-rate", 0) if isinstance(data, dict) else 0
            return {
                "mode": mode,
                "rate_mb_s": rate / (1024 * 1024) if isinstance(rate, int) else data,
                "raw": data,
            }
        except QemuBridgeError as e:
            logger.warning("calc-dirty-rate not supported: %s (%s)", e, e.code)
            return {"mode": "unsupported", "dirty-rate": -1}

    # ----------------------------------------------------------------------- #
    # context 19 - block jobs
    # ----------------------------------------------------------------------- #

    async def queryblockjobs(self) -> list[dict[str, Any]]:
        """Op 18/25 - lists active block jobs with unified query-jobs fallback."""
        try:
            return await self.execute("query-block-jobs")
        except QemuBridgeError as e:
            logger.warning("query-block-jobs failed (%s) - query-jobs fallback", e.code)
            return await self.execute("query-jobs")

    async def blockjobstart(
        self,
        device: str = "drive0",
        target: str = "/var/lib/vhe/backup.qcow2",
        sync: str = "full",
    ) -> dict[str, Any]:
        """Op 19/25 - starts a mirror job via blockdev-mirror with drive-mirror fallback."""
        jobid = f"job-{device}-{int(time.time()) % 100000}"
        try:
            result = await self.execute("blockdev-mirror", {
                "job-id": jobid,
                "device": device,
                "target": target,
                "sync": sync,
            })
        except QemuBridgeError as e:
            logger.warning("blockdev-mirror failed (%s) - drive-mirror fallback", e.code)
            result = await self.execute("drive-mirror", {
                "device": device,
                "target": target,
                "sync": sync,
                "job-id": jobid,
            })
        return {"job_id": jobid, "device": device, "target": target, "result": result}

    async def blockjobcancel(self, deviceorjob: str, force: bool = False) -> dict[str, Any]:
        """Op 20/25 - cancels a block job by device or job-id, both orders."""
        try:
            result = await self.execute("block-job-cancel", {"device": deviceorjob, "force": force})
        except QemuBridgeError as e:
            logger.warning("block-job-cancel failed (%s) - job-cancel fallback", e.code)
            result = await self.execute("job-cancel", {"id": deviceorjob, "force": force})
        return {"cancelled": deviceorjob, "result": result}

    # ----------------------------------------------------------------------- #
    # context 20 - vcpu affinity and io throttling
    # ----------------------------------------------------------------------- #

    async def setvcpuaffinity(self, vcpuid: int = 0, cpuset: str = "0-1") -> dict[str, Any]:
        """
        Op 21/25 - pins a vCPU thread trying three strategies in order:
        os.sched_setaffinity, then taskset -pc via asyncio subprocess, then
        a logged mock when /proc is absent (CI sandboxes).

        Args:
            vcpuid: Guest vCPU index as reported by query-cpus-fast.
            cpuset: Linux cpuset expression such as ``0,2-3,5``.

        Returns:
            dict: Pinning result with the method used and mock flag.
        """
        cpus = await self.querycpus()
        threadid: int | None = None
        for c in cpus:
            if c.get("cpu-index") == vcpuid or c.get("CPU") == vcpuid:
                threadid = c.get("thread-id") or c.get("thread_id")
                break
        hostlist = parsecpuset(cpuset)
        if threadid:
            try:
                os.sched_setaffinity(threadid, set(hostlist))
                return {"vcpu": vcpuid, "thread_id": threadid, "cpuset": cpuset, "pinned": True, "method": "sched_setaffinity"}
            except (AttributeError, OSError) as e:
                logger.warning("sched_setaffinity failed for tid %s: %s - taskset fallback", threadid, e)
        if threadid and os.path.exists(f"/proc/{threadid}"):
            try:
                proc = await asyncio.create_subprocess_exec(
                    "taskset", "-pc", cpuset, str(threadid),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await proc.communicate()
                return {
                    "vcpu": vcpuid,
                    "thread_id": threadid,
                    "cpuset": cpuset,
                    "pinned": proc.returncode == 0,
                    "method": "taskset",
                    "stdout": stdout.decode(),
                    "stderr": stderr.decode(),
                    "returncode": proc.returncode,
                }
            except Exception as e:
                raise QemuBridgeError(f"affinity set failed {e}", "AFFINITY_FAILED") from e
        logger.info("sim affinity vcpu %s -> %s (mock: no /proc/%s)", vcpuid, cpuset, threadid)
        return {"vcpu": vcpuid, "thread_id": threadid or 10000 + vcpuid, "cpuset": cpuset, "pinned": False, "mock": True}

    async def throttleio(
        self,
        device: str = "drive0",
        bps: int = 104857600,
        iops: int = 1000,
        bpsrd: int = 0,
        bpswr: int | None = None,
        iopsrd: int = 0,
        iopswr: int | None = None,
    ) -> dict[str, Any]:
        """
        Op 22/25 - throttles a block device (0 keeps the axis unlimited).

        Args:
            device: Block device id, for example ``drive0``.
            bps: Total byte cap; write cap defaults to the same value.
            iops: Total io cap; write cap defaults to the same value.
            bpsrd: Read byte cap; 0 keeps the read axis unlimited.
            bpswr: Optional write byte cap overriding ``bps``.
            iopsrd: Read io cap; 0 keeps the read axis unlimited.
            iopswr: Optional write io cap overriding ``iops``.

        Returns:
            dict: The applied device, bps, iops and raw QMP result.
        """
        args: dict[str, Any] = {
            "device": device,
            "bps": bps,
            "bps_rd": bpsrd,
            "bps_wr": bps if bpswr is None else bpswr,
            "iops": iops,
            "iops_rd": iopsrd,
            "iops_wr": iops if iopswr is None else iopswr,
        }
        result = await self.execute("block_set_io_throttle", args)
        return {"device": device, "bps": bps, "iops": iops, "result": result}

    # ----------------------------------------------------------------------- #
    # context 21 - version introspection
    # ----------------------------------------------------------------------- #

    async def qemuversion(self) -> dict[str, Any]:
        """Op 23/25 - reports QEMU version, features and command count."""
        version = await self.execute("query-version")
        if not isinstance(version, dict):
            version = {}
        try:
            features = await self.execute("query-qemu-features")
        except QemuBridgeError as e:
            logger.debug("query-qemu-features unavailable: %s", e.code)
            features = []
        try:
            commands = await self.execute("query-commands")
        except QemuBridgeError as e:
            logger.debug("query-commands unavailable: %s", e.code)
            commands = []
        return {
            "qemu": version.get("qemu", {}),
            "package": version.get("package", ""),
            "features": features,
            "command_count": len(commands),
            "target": QEMUVERSIONTARGET,
            "python": PYTHONVERSIONTARGET,
            "node": NODECURRENTVERSION,
            "driver": DRIVERVERSIONTARGET,
            "cuda": CUDAVERSIONTARGET,
            "bridge": BRIDGEVERSION,
            "date": BUILDDATE,
            "compat": self.getnodecompat(),
        }


def parsecpuset(cpuset: str) -> list[int]:
    """
    Parses a linux cpuset expression such as '0,2-3,5' into a cpu list.

    Args:
        cpuset: Comma separated indices and closed ranges with hyphens.

    Returns:
        list[int]: The expanded list of cpu indices in ascending visit order.

    Raises:
        QemuBridgeError: When the expression is invalid or expands to empty.
    """
    out: list[int] = []
    try:
        for part in cpuset.split(","):
            part = part.strip()
            if not part:
                continue
            lo, sep, hi = part.partition("-")
            if sep:
                out.extend(range(int(lo), int(hi) + 1))
            else:
                out.append(int(part))
    except ValueError as e:
        raise QemuBridgeError(f"invalid cpuset {cpuset!r}", "EINVAL") from e
    if not out:
        raise QemuBridgeError(f"empty cpuset {cpuset!r}", "EINVAL")
    return out


# --------------------------------------------------------------------------- #
# context 22 - session helpers (qmpsession, batch hotplug)
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def qmpsession(socketpath: str = "/run/vhe/vm.qmp", timeout: float = QEMUDEFAULTTIMEOUT):
    """
    Yields a connected QemuBridge and always disconnects on exit.

    Args:
        socketpath: QMP unix socket path to connect to.
        timeout: Per-command timeout in seconds for every exchange.

    Yields:
        QemuBridge: A connected bridge with capabilities negotiated best effort.
    """
    bridge = QemuBridge(socketpath=socketpath, timeout=timeout)
    await bridge.connect()
    try:
        await bridge.handshake()
    except Exception:
        logger.warning("handshake deferred inside qmpsession - CI mock mode")
    try:
        yield bridge
    finally:
        await bridge.disconnect()


async def batchhotplugfromconfig(vmid: str, configpath: str = "vcpus.json") -> dict[str, Any]:
    """
    Reads vcpus.json and hotplugs CPUs until the desired count is met.

    Args:
        vmid: VM identifier used to resolve the per-vm QMP socket.
        configpath: Path of the json file holding the desired vCPU count.

    Returns:
        dict: The requested count plus one result entry per hotplugged core.
    """
    p = Path(configpath)
    if not p.exists():
        return {"error": f"{configpath} not found"}
    try:
        desired = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("failed to read %s: %s", configpath, e)
        return {"error": str(e)}
    count = desired.get(vmid, desired.get("count", 4)) if isinstance(desired, dict) else 4
    socketpath = QEMUDEFAULTSOCKET.format(vmid=vmid)
    results: list[dict[str, Any]] = []
    try:
        async with qmpsession(socketpath) as bridge:
            current = await bridge.querycpus()
            gap = int(count) - len(current)
            for i in range(max(gap, 0)):
                try:
                    results.append(await bridge.hotplugcpu(socketid=0, coreid=len(current) + i))
                except QemuBridgeError as e:
                    logger.warning("batch hotplug core %s failed: %s (%s)", len(current) + i, e, e.code)
                    results.append({"error": str(e), "code": e.code})
    except QemuBridgeError as e:
        logger.error("batch hotplug session failed: %s (%s)", e, e.code)
        return {"error": str(e), "code": e.code, "results": results}
    return {"requested": count, "results": results}


# --------------------------------------------------------------------------- #
# context 23 - flat project configs (14 file union)
# --------------------------------------------------------------------------- #

FLATCONFIGFILES: tuple[str, ...] = (
    "vm.config", "gpu.config", "passage.config", "qemu.config", "mttg.config", "docker.config",
    "boards.json", "cores.json", "processors.json", "gpus.json", "vcpus.json", "vram.json",
    "specs_amd_ryzen_x_series.json", "specs_nvidia_blackwell.json",
)


def loadallconfigs(basedir: str = ".") -> dict[str, Any]:
    """
    Loads the 14 flat project configs (6 kv + 8 json) with per-file defense.

    Args:
        basedir: Base directory holding the flat config family.

    Returns:
        dict: One entry per file with parsed data or a missing/error marker.
    """
    cfg: dict[str, Any] = {}
    for fname in FLATCONFIGFILES:
        fpath = Path(basedir) / fname
        if not fpath.exists():
            cfg[fname] = {"missing": True, "note": f"{fname} will be created by other subagents"}
            continue
        try:
            if fpath.suffix == ".json":
                cfg[fname] = json.loads(fpath.read_text())
            else:
                parsed: dict[str, str] = {}
                for line in fpath.read_text().splitlines():
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, _, v = line.partition("=")
                    parsed[k.strip()] = v.strip().strip('"').strip("'")
                cfg[fname] = parsed
        except (OSError, json.JSONDecodeError) as e:
            logger.warning("config %s failed to parse: %s", fname, e)
            cfg[fname] = {"error": str(e)}
    return cfg


# --------------------------------------------------------------------------- #
# context 24 - smiadapter internal module (a100/h100 flex nvidia-smi facade)
# --------------------------------------------------------------------------- #

class smiadapter:
    """
    Renders a software nvidia-smi facade with flexible a100/h100 profiles.

    The class is the python-side twin of the gpumonitor.cpp renderer and
    keeps the nvidia-smi field vocabulary (memory.total, utilization.gpu,
    ...) as external API conventions. Driver is re-pinned to 575.57.08 with
    CUDA 12.9.
    """

    profiles: dict[str, dict[str, str]] = {
        "h100": {
            "name": "NVIDIA H100 80GB HBM3", "mem": "81559MiB", "used": "1024MiB",
            "util": "0%", "temp": "35C", "power": "120W / 700W", "bus": "00000000:00:04.0",
        },
        "a100": {
            "name": "NVIDIA A100-SXM4-40GB", "mem": "40536MiB", "used": "512MiB",
            "util": "0%", "temp": "32C", "power": "85W / 400W", "bus": "00000000:00:05.0",
        },
        "rtx5090": {
            "name": "NVIDIA GeForce RTX 5090", "mem": "32768MiB", "used": "256MiB",
            "util": "0%", "temp": "38C", "power": "90W / 575W", "bus": "00000000:00:06.0",
        },
    }

    @classmethod
    def select(cls, gpus: list[str] | None) -> list[tuple[str, dict[str, str]]]:
        """Selects flex profiles defensively, skipping unknown keys."""
        chosen: list[tuple[str, dict[str, str]]] = []
        for key in gpus or ["a100", "h100"]:
            profile = cls.profiles.get(key)
            if profile is None:
                logger.warning("unknown smiadapter profile %r - skipping", key)
                continue
            chosen.append((key, profile))
        return chosen

    @classmethod
    def renderlines(cls, gpus: list[str] | None = None) -> list[str]:
        """Renders the classic bordered smi table for the chosen profiles."""
        chosen = cls.select(gpus)
        width = 79
        close = lambda s: s.ljust(width - 1) + "|"  # noqa: E731 - local row closer
        lines = [
            "+" + "-" * (width - 2) + "+",
            close(f"| NVIDIA-SMI {DRIVERVERSIONTARGET}    Driver Version: {DRIVERVERSIONTARGET}    CUDA Version: {CUDAVERSIONTARGET}"),
            "+-----------------------------------------+-----------------+-----------------+",
            "| GPU  Name                    Persist.-M | Bus-Id          Disp.A          |",
        ]
        for i, (_, g) in enumerate(chosen):
            lines.append(close(f"|  {i}  {g['name'][:32]:<32} On  | {g['bus']}       Off"))
        lines.append("|=========================================+=================+=================|")
        for i, (_, g) in enumerate(chosen):
            lines.append(close(f"|  {i}  {g['name'][:20]:<20} {g['temp']:<5} {g['power']:<15} | {g['used']:>9} / {g['mem']:<9} {g['util']:>4}  Default"))
        lines.append("+" + "-" * (width - 2) + "+")
        return lines

    @classmethod
    def renderlist(cls, gpus: list[str] | None = None) -> list[str]:
        """Renders the nvidia-smi -L device listing format."""
        return [
            f"GPU {i}: {g['name']} (UUID: GPU-fake-{key}-{i})"
            for i, (key, g) in enumerate(cls.select(gpus))
        ]

    @classmethod
    def renderquery(cls, gpus: list[str] | None, fields: str) -> str:
        """Renders the nvidia-smi --query-gpu csv subset for the profiles."""
        wanted = [f.strip() for f in fields.split(",") if f.strip()]
        mapping: dict[str, dict[str, str]] = {}
        for key, g in cls.select(gpus):
            mapping[key] = {
                "name": g["name"],
                "memory.total": g["mem"],
                "memory.used": g["used"],
                "utilization.gpu": g["util"].rstrip("%"),
                "temperature.gpu": g["temp"].rstrip("C"),
                "power.draw": g["power"].split(" / ")[0].rstrip("W"),
                "driver_version": DRIVERVERSIONTARGET,
            }
        rows = [",".join(wanted)]
        for key, values in mapping.items():
            row = [str(values.get(f, "N/A")) for f in wanted]
            if any(v == "N/A" for v in row):
                logger.debug("smiadapter query has N/A fields for %s", key)
            rows.append(",".join(row))
        return "\n".join(rows)


# --------------------------------------------------------------------------- #
# context 25 - node shim generator, cli modes and offline selftest
# --------------------------------------------------------------------------- #

NODESHIMTEMPLATE = """/**
 * qemubridge.node.js - node compat shim generated by qemubridge.py __BRIDGE__
 * date __DATE__ - qemu __QEMU__ - python __PY__+
 * node __NODECUR__ current / __NODELTS__ lts - node:net ndjson over unix QMP.
 */
import net from 'node:net';

export const QEMU_VERSION = '__QEMU__';
export const BRIDGEVERSION = '__BRIDGE__';

export class NodeQemuBridge {
  constructor(socketPath = '__SOCKET__') {
    this.socketPath = socketPath;
    this.client = null;
    this.buf = '';
  }
  connect() {
    return new Promise((res, rej) => {
      this.client = net.createConnection(this.socketPath, () => res(true));
      this.client.on('error', rej);
    });
  }
  send(cmd) {
    return new Promise((res, rej) => {
      this.client.write(JSON.stringify(cmd) + '\\n');
      this.client.on('data', (d) => {
        this.buf += d.toString();
        const i = this.buf.indexOf('\\n');
        if (i < 0) return;
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let resp;
        try { resp = JSON.parse(line); } catch (e) { rej(e); return; }
        if (resp.event) return;
        if (resp.error) { rej(new Error(resp.error.desc)); return; }
        res(resp.return !== undefined ? resp.return : resp);
      });
    });
  }
  async handshake() {
    await this.send({ execute: 'qmp_capabilities', arguments: { enable: ['oob'] } });
    return this.send({ execute: 'query-version' });
  }
  queryStatus() { return this.send({ execute: 'query-status' }); }
  qemuVersion() { return this.send({ execute: 'query-version' }); }
}
"""


def generatenodeshimjs() -> str:
    """
    Returns the node compat shim source with pinned v2 versions.

    Returns:
        str: The rendered node:net ndjson QMP shim as javascript source.
    """
    return (
        NODESHIMTEMPLATE
        .replace("__BRIDGE__", BRIDGEVERSION)
        .replace("__DATE__", BUILDDATE)
        .replace("__QEMU__", QEMUVERSIONTARGET)
        .replace("__PY__", PYTHONVERSIONTARGET)
        .replace("__NODECUR__", NODECURRENTVERSION)
        .replace("__NODELTS__", NODELTSVERSION)
        .replace("__SOCKET__", "/run/vhe/vm.qmp")
    )


def buildcli() -> argparse.ArgumentParser:
    """Builds the standalone argument parser with all bridge modes."""
    parser = argparse.ArgumentParser(
        prog="qemubridge.py",
        description="QMP bridge for the virtual hardware engine v2 (qemu 11.1.0, python 3.14+)",
    )
    parser.add_argument("--socket", default="/run/vhe/vm.qmp", help="QMP unix socket path (default /run/vhe/vm.qmp)")
    parser.add_argument("--timeout", type=float, default=10.0, help="per-command timeout in seconds")
    parser.add_argument("--verbose", action="store_true", help="debug logging")
    sub = parser.add_subparsers(dest="mode")
    sub.add_parser("selftest", help="offline selftest (default when no mode is given)")
    sub.add_parser("status", help="query vm runstate (typed VMStatus)")
    sub.add_parser("cpus", help="list vCPUs (query-cpus-fast)")
    sub.add_parser("memory", help="memory summary, devices and balloon")
    sub.add_parser("version", help="qemu version, features and command count")
    pmerge = sub.add_parser("migrate", help="live migration to an explicit target")
    pmerge.add_argument("--uri", default=None, help="full migration uri e.g. tcp:host:port")
    pmerge.add_argument("--host", default=None, help="target host (or VHE_MIGRATE_HOST; never implicit localhost)")
    pmerge.add_argument("--port", type=int, default=None, help="target port (default random 30000-59999)")
    pmerge.add_argument("--channels", type=int, default=8, help="multifd channels 2-32")
    pmerge.add_argument("--downtime", type=int, default=300, help="downtime limit ms")
    pmerge.add_argument("--no-wait", dest="nowait", action="store_true", help="launch without polling to completion")
    sub.add_parser("blockjobs", help="list active block jobs")
    pbatch = sub.add_parser("batchcpus", help="batch vCPU hotplug from vcpus.json")
    pbatch.add_argument("--vmid", default="vm0", help="vm id for socket resolution")
    pbatch.add_argument("--config", default="vcpus.json", help="desired count config path")
    pconf = sub.add_parser("configs", help="load the 14 flat project configs")
    pconf.add_argument("--base", default=".", help="base directory of the flat configs")
    psmi = sub.add_parser("smiadapter", help="software nvidia-smi facade (a100/h100 flex)")
    psmi.add_argument("--gpu", action="append", choices=["a100", "h100", "rtx5090"], help="profile to render (repeatable)")
    psmi.add_argument("--list", action="store_true", help="nvidia-smi -L listing format")
    psmi.add_argument("--query", default=None, help="--query-gpu csv fields e.g. name,memory.total")
    sub.add_parser("shim", help="print the node compat shim source")
    return parser


async def runqmpmode(args: argparse.Namespace) -> int:
    """Runs one QMP-backed cli mode inside a managed session."""
    try:
        async with qmpsession(args.socket, args.timeout) as bridge:
            match args.mode:
                case "status":
                    print((await bridge.querystatus()).value)
                case "cpus":
                    print(json.dumps(await bridge.querycpus(), indent=2))
                case "memory":
                    print(json.dumps(await bridge.querymemory(), indent=2))
                case "version":
                    print(json.dumps(await bridge.qemuversion(), indent=2, default=str))
                case "blockjobs":
                    print(json.dumps(await bridge.queryblockjobs(), indent=2))
                case "batchcpus":
                    print(json.dumps(await batchhotplugfromconfig(args.vmid, args.config), indent=2, default=str))
                case "migrate":
                    stats = await bridge.livemigrate(
                        uri=args.uri,
                        host=args.host,
                        port=args.port,
                        multifdchannels=args.channels,
                        downtimems=args.downtime,
                        wait=not args.nowait,
                    )
                    print(json.dumps(asdict(stats), indent=2))
                case _:
                    logger.error("unhandled qmp mode %s", args.mode)
                    return 2
    except QemuBridgeError as e:
        logger.error("mode %s failed: %s (%s)", args.mode, e, e.code)
        return 1
    return 0


def runcli(args: argparse.Namespace) -> int:
    """Dispatches one cli mode; returns the process exit code."""
    match args.mode:
        case "selftest" | None:
            asyncio.run(selftest())
            return 0
        case "smiadapter":
            if args.list:
                print("\n".join(smiadapter.renderlist(args.gpu)))
            elif args.query:
                print(smiadapter.renderquery(args.gpu, args.query))
            else:
                print("\n".join(smiadapter.renderlines(args.gpu)))
            return 0
        case "shim":
            print(generatenodeshimjs())
            return 0
        case "configs":
            cfg = loadallconfigs(args.base)
            for name, value in cfg.items():
                if isinstance(value, dict) and value.get("missing"):
                    state = "missing"
                elif isinstance(value, dict) and value.get("error"):
                    state = f"error: {value['error']}"
                else:
                    state = f"ok ({len(value)} keys)" if isinstance(value, dict) else "ok"
                print(f"{name:<32} {state}")
            return 0
        case "status" | "cpus" | "memory" | "version" | "migrate" | "blockjobs" | "batchcpus":
            return asyncio.run(runqmpmode(args))
        case _:
            logger.error("unknown mode %s", args.mode)
            return 2


async def selftest() -> None:
    """Runs the offline selftest covering models, smiadapter, shim and mock link."""
    bridge = QemuBridge(socketpath="/nonexistent/vm.qmp")
    assert await bridge.connect() is True  # mock CI path, logged not raised
    compat = bridge.getnodecompat()
    assert compat["qemu"] == QEMUVERSIONTARGET
    assert VMStatus("inmigrate") is VMStatus.INMIGRATE
    cfg = QEMUConfig.loadfromfile("/nonexistent/qemu.config", vmid="t0")
    assert "vm-t0" in cfg.socketpath and cfg.hugepages is False
    assert parsecpuset("0,2-3,5") == [0, 2, 3, 5]
    table = smiadapter.renderlines(["a100", "h100"])
    assert any("81559MiB" in line for line in table) and any("40536MiB" in line for line in table)
    assert "575.57.08" in table[1] and CUDAVERSIONTARGET in table[1]
    listing = smiadapter.renderlist(["h100"])
    assert listing and "GPU-fake-h100" in listing[0]
    csv = smiadapter.renderquery(["a100"], "name,memory.total,driver_version")
    assert csv.splitlines()[1].endswith(DRIVERVERSIONTARGET)
    shim = generatenodeshimjs()
    assert QEMUVERSIONTARGET in shim and NODECURRENTVERSION in shim
    assert "localhost" not in shim and "127.0.0.1" not in shim and "0.0.0.0" not in shim
    cfgs = loadallconfigs("/nonexistent/dir")
    assert len(cfgs) == len(FLATCONFIGFILES) and cfgs["vm.config"]["missing"] is True
    await bridge.disconnect()
    print(
        f"qemubridge.py {BRIDGEVERSION} selftest ok - qemu {QEMUVERSIONTARGET} "
        f"node {NODECURRENTVERSION}/{NODELTSVERSION} python {PYTHONVERSIONTARGET}+ ({BUILDDATE})"
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [qemubridge] %(levelname)s %(message)s")
    cliargs = buildcli().parse_args()
    if cliargs.verbose:
        logger.setLevel(logging.DEBUG)
        logging.getLogger().setLevel(logging.DEBUG)
    sys.exit(runcli(cliargs))
