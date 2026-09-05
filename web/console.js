  /**
   * index console: pure vanilla es module wiring the browser-pure engine
   * port (sandbox.js) to the terminal, the spec panel and the bus event
   * timeline. when the page is served by web/server.js the console also
   * talks to the /api/v1 endpoints; otherwise everything runs locally.
   */
  import {
    cpudata, gpudata, commands, bootSequence, createSandboxState, dispatch,
  } from './sandbox.js';

  const termout = document.getElementById('termout');
  const termform = document.getElementById('termform');
  const termin = document.getElementById('termin');
  const termstate = document.getElementById('termstate');
  const promptlabel = document.getElementById('promptlabel');
  const apibadge = document.getElementById('apibadge');
  const eventlist = document.getElementById('eventlist');
  const eventempty = document.getElementById('eventempty');
  const cpusel = document.getElementById('cpusel');
  const quotasel = document.getElementById('quotasel');
  const ramnum = document.getElementById('ramnum');
  const cpushint = document.getElementById('cpuhint');
  const gpusel = document.getElementById('gpusel');
  const gpuhint = document.getElementById('gpuhint');
  const vcpurange = document.getElementById('vcpurange');
  const vcpuval = document.getElementById('vcpuval');
  const ramrange = document.getElementById('ramrange');
  const ramval = document.getElementById('ramval');
  const migsel = document.getElementById('migsel');
  const startbtn = document.getElementById('startbtn');
  const snapbtn = document.getElementById('snapbtn');
  const stopbtn = document.getElementById('stopbtn');

  /** display cap for very large payloads such as cpuinfo at 192 vcpus. */
  const displaycap = 120000;

  let state = null;          // local engine sandbox state
  let apisandbox = null;     // api sandbox id when connected
  let apimode = false;
  let running = false;
  let history = [];
  let historyindex = -1;
  let seq = 0;

  /* ---------------- spec panel ---------------- */

  for (const cpu of cpudata) {
    const option = document.createElement('option');
    option.value = cpu.model;
    option.textContent = `${cpu.model} (${cpu.cores}c/${cpu.threads}t)`;
    cpusel.append(option);
  }

  for (const gpu of gpudata) {
    const option = document.createElement('option');
    option.value = gpu.id;
    option.textContent = `${gpu.name} (${gpu.memtype} ${gpu.vrammib / 1024} gb)`;
    gpusel.append(option);
  }

  function refreshhints() {
    const cpu = cpudata.find((entry) => entry.model === cpusel.value);
    const gpu = gpudata.find((entry) => entry.id === gpusel.value);
    cpushint.textContent = cpu
      ? `${cpu.microarch} &middot; ${cpu.memorytype} &middot; up to ${cpu.maxmemorygb} gb &middot; ${cpu.tdpwatts} w`
      : '';
    gpuhint.textContent = gpu
      ? `${gpu.arch} &middot; ${gpu.bandwidthgbs} gb/s &middot; mig ${gpu.mig ? 'supported' : 'not supported (profile emulated)'}`
      : '';
    vcpuval.textContent = vcpurange.value;
    ramval.textContent = ramrange.value;
    if (ramnum !== null && document.activeElement !== ramnum) {
      ramnum.value = ramrange.value;
    }
  }
  if (ramnum !== null) {
    ramnum.addEventListener('input', () => {
      const v = Math.max(1, Math.min(18432, Number(ramnum.value) || 1));
      ramrange.value = v;
      ramval.textContent = String(v);
    });
  }
  cpusel.addEventListener('change', refreshhints);
  gpusel.addEventListener('change', refreshhints);
  vcpurange.addEventListener('input', refreshhints);
  ramrange.addEventListener('input', refreshhints);
  refreshhints();

  /* ---------------- terminal plumbing ---------------- */

  function scrollterm() {
    termout.scrollTop = termout.scrollHeight;
  }

  /** appends one text block as a row; truncates giant payloads for display. */
  function termprint(text, cls) {
    const block = document.createElement('span');
    if (cls) block.className = cls;
    if (text.length > displaycap) {
      const note = document.createElement('span');
      note.className = 'trunc';
      note.textContent = `... output truncated for display (${text.length} bytes total)`;
      block.textContent = `${text.slice(0, displaycap)}\n`;
      termout.append(block, note, document.createTextNode('\n'));
    } else {
      block.textContent = text;
      termout.append(block, document.createTextNode('\n'));
    }
    scrollterm();
  }

  function clearterm() {
    termout.replaceChildren();
  }

  /* ---------------- bus events ---------------- */

  function logevent(topic, detail, kind) {
    if (eventempty.isConnected) eventempty.remove();
    const now = new Date();
    const item = document.createElement('li');
    if (kind) item.className = kind;
    const head = document.createElement('span');
    head.className = 'time';
    head.textContent = `${now.toTimeString().slice(0, 8)} #${(seq += 1)} `;
    const name = document.createElement('span');
    name.className = 'topic';
    name.textContent = topic;
    const body = document.createElement('span');
    body.className = 'detail';
    body.textContent = detail;
    item.append(head, name, body);
    eventlist.prepend(item);
    while (eventlist.children.length > 50) eventlist.lastChild.remove();
  }

  /* ---------------- api detection ---------------- */

  async function detectapi() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const response = await fetch('api/v1/health', { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) {
        const health = await response.json();
        if (health.ok === true) {
          apimode = true;
          apibadge.textContent = `api connected (v${health.version}, uptime ${health.uptime}s)`;
          apibadge.classList.add('apion');
          return;
        }
      }
    } catch {
      /* file:// or standalone static hosting: local engine mode */
    }
    apibadge.textContent = 'engine: local (no api)';
  }
  detectapi();

  /* ---------------- boot sequence ---------------- */

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function bootsandbox() {
    startbtn.disabled = true;
    snapbtn.disabled = true;
    stopbtn.disabled = true;
    cpusel.disabled = true;
    gpusel.disabled = true;
    migsel.disabled = true;
    vcpurange.disabled = true;
    ramrange.disabled = true;
    clearterm();
    termstate.textContent = 'booting';

    const spec = {
      model: cpusel.value,
      vcpus: Number(vcpurange.value),
      ramgb: Number(ramnum !== null && ramnum.value ? ramnum.value : ramrange.value),
      gpu: gpusel.value,
      mig: migsel.value,
      quotamb: quotasel !== null ? Number(quotasel.value) : undefined,
    };
    state = createSandboxState(spec);
    promptlabel.textContent = `root@${state.hostname}:~#`;

    logevent('vm:creating', `${spec.model} x${state.vcpus} vcpus, ${spec.ramgb} gb ram, ${spec.gpu}`, 'lifecycle');

    /* api-backed sandbox when the self-hosted server answers */
    if (apimode) {
      try {
        const response = await fetch('api/v1/sandboxes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(spec),
        });
        if (response.ok) {
          const created = await response.json();
          apisandbox = created.id;
          logevent('sandbox:created', `api sandbox ${created.id} state ${created.state}`, 'lifecycle');
        }
      } catch {
        apisandbox = null;
        logevent('sandbox:create-failed', 'api unreachable; falling back to the local engine', 'lifecycle');
      }
    }

    termprint(`saddle sandbox booting (${spec.model}, ${state.vcpus} vcpus, ${spec.ramgb} gb, ${spec.gpu})`, 'boot');
    const lines = bootSequence(spec.model, state.vcpus, spec.ramgb, spec.gpu);
    for (const bootline of lines) {
      termprint(bootline, 'boot');
      await sleep(28 + Math.random() * 34);
    }
    termprint('ok: sandbox running. type "help" for the command list.', 'ok');
    logevent('vm:created', `sandbox ${state.id} specs committed`, 'lifecycle');
    logevent('vm:started', 'firecracker microvm 125 ms bring-up complete', 'lifecycle');

    running = true;
    termstate.textContent = 'running';
    termform.classList.remove('off');
    termin.disabled = false;
    snapbtn.disabled = false;
    stopbtn.disabled = false;
    termin.focus();
  }

  startbtn.addEventListener('click', () => {
    bootsandbox().catch(() => {
      termprint('boot failed unexpectedly; check the console log', 'err');
      startbtn.disabled = false;
    });
  });

  /* ---------------- command execution ---------------- */

  async function runcommand(rawcommand) {
    termprint(`${promptlabel.textContent} ${rawcommand}`, 'cmdline');
    history.push(rawcommand);
    historyindex = history.length;

    if (rawcommand === 'clear') {
      clearterm();
      return;
    }
    let result = null;
    let source = 'local';
    if (apisandbox !== null) {
      try {
        const response = await fetch(`api/v1/sandboxes/${apisandbox}/exec`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: rawcommand }),
        });
        if (response.ok) {
          result = await response.json();
          source = 'api';
        }
      } catch {
        result = null;
      }
    }
    if (result === null) {
      result = dispatch(rawcommand, state);
      source = 'local';
    }
    if (result.output.length > 0) {
      termprint(result.output, result.exitCode === 0 ? '' : 'err');
    }
    logevent('exec:completed', `"${rawcommand}" exit ${result.exitCode} via ${source}`, 'exec');
  }

  termform.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!running) return;
    const value = termin.value.trim();
    termin.value = '';
    if (value.length === 0) return;
    await runcommand(value);
  });

  termin.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (history.length === 0) return;
      historyindex = Math.max(0, historyindex - 1);
      termin.value = history[historyindex] ?? '';
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (history.length === 0) return;
      historyindex = Math.min(history.length, historyindex + 1);
      termin.value = history[historyindex] ?? '';
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const prefix = termin.value.trim();
      if (prefix.length === 0) return;
      const match = commands.find((entry) => entry.startsWith(prefix));
      if (match !== undefined) termin.value = match;
    }
  });

  termout.addEventListener('click', () => termin.focus());

  /* ---------------- snapshot and stop ---------------- */

  snapbtn.addEventListener('click', () => {
    if (!running) return;
    const snapid = `snap-${Math.random().toString(16).slice(2, 10)}`;
    termprint(`snapshot ${snapid} created (memory + disk, precopy stage 1 of 1)`, 'ok');
    logevent('snapshot:created', `${snapid} for sandbox ${state?.id ?? 'n/a'}`, 'snapshot');
  });

  stopbtn.addEventListener('click', async () => {
    if (!running) return;
    running = false;
    termstate.textContent = 'stopped';
    termin.disabled = true;
    termform.classList.add('off');
    snapbtn.disabled = true;
    stopbtn.disabled = true;
    termprint('sandbox stopped; snapshot-less teardown complete.', 'boot');
    logevent('vm:stopped', `sandbox ${state?.id ?? 'n/a'} torn down`, 'lifecycle');
    if (apisandbox !== null) {
      try {
        await fetch(`api/v1/sandboxes/${apisandbox}`, { method: 'DELETE' });
        logevent('vm:deleted', `api sandbox ${apisandbox} destroyed`, 'lifecycle');
      } catch {
        logevent('vm:delete-failed', `api sandbox ${apisandbox} unreachable`, 'lifecycle');
      }
      apisandbox = null;
    }
    cpusel.disabled = false;
    gpusel.disabled = false;
    migsel.disabled = false;
    vcpurange.disabled = false;
    ramrange.disabled = false;
    startbtn.disabled = false;
    startbtn.textContent = 'start sandbox';
  });
