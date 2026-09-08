// Spec panel: faithful absorption of the console.html spec controls — cpu
// model, workspace quota, vcpus slider, ram slider + exact numeric field,
// gpu model and mig profile, each with the live catalog hints.
import { useEffect, useRef, useState } from "react";
import { cpudata, gpudata } from "../sandbox.ts";

/** the sandbox specification selection held by the console page. */
export type SandboxSpecSelection = {
  model: string;
  quotamb: number;
  vcpus: number;
  ramgb: number;
  gpu: string;
  mig: string;
};

type SpecPanelProps = {
  spec: SandboxSpecSelection;
  onChange: (patch: Partial<SandboxSpecSelection>) => void;
  disabled: boolean;
};

/** workspace quota options in MiB (16 selected by default). */
const quotaoptions = [4, 16, 64, 256];

/** mig slicing profiles of the 96 gb-class virtual device. */
const migoptions = [
  { value: "off", label: "off (full device)" },
  { value: "1g.24gb", label: "1g.24gb · 24 gb x 4" },
  { value: "2g.48gb", label: "2g.48gb · 48 gb x 2" },
  { value: "4g.96gb", label: "4g.96gb · 96 gb x 1" },
];

/** ram ceiling shared by the slider and the exact numeric field. */
const ramceiling = 18432;

/**
 * the sandbox specification panel: every control keeps the 44px touch
 * target of the absorbed static page and disables while a sandbox is
 * booting or running.
 */
export default function SpecPanel({ spec, onChange, disabled }: SpecPanelProps) {
  const ramnumref = useRef<HTMLInputElement>(null);
  const [ramdraft, setRamdraft] = useState(String(spec.ramgb));

  /** the numeric field follows the slider unless the operator is typing. */
  useEffect(() => {
    if (document.activeElement !== ramnumref.current) {
      setRamdraft(String(spec.ramgb));
    }
  }, [spec.ramgb]);

  /** the exact ram field clamps to the 1..18432 gb plan range. */
  const onramnuminput = (raw: string) => {
    setRamdraft(raw);
    const clamped = Math.max(1, Math.min(ramceiling, Number(raw) || 1));
    onChange({ ramgb: clamped });
  };

  const cpu = cpudata.find((entry) => entry.model === spec.model);
  const gpu = gpudata.find((entry) => entry.id === spec.gpu);
  const cpuhint = cpu
    ? `${cpu.microarch} · ${cpu.memorytype} · up to ${cpu.maxmemorygb} gb · ${cpu.tdpwatts} w`
    : "";
  const gpuhint = gpu
    ? `${gpu.arch} · ${gpu.bandwidthgbs} gb/s · mig ${gpu.mig ? "supported" : "not supported (profile emulated)"}`
    : "";

  return (
    <>
      <div className="spec-field">
        <label htmlFor="cpusel">cpu model</label>
        <select
          className="spec-select"
          id="cpusel"
          disabled={disabled}
          aria-label="virtual cpu model"
          value={spec.model}
          onChange={(event) => onChange({ model: event.target.value })}
        >
          {cpudata.map((entry) => (
            <option key={entry.model} value={entry.model}>
              {`${entry.model} (${entry.cores}c/${entry.threads}t)`}
            </option>
          ))}
        </select>
        <div className="spec-field">
          <label htmlFor="quotasel">workspace quota</label>
          <select
            className="spec-select"
            id="quotasel"
            disabled={disabled}
            aria-label="persistent workspace quota"
            value={String(spec.quotamb)}
            onChange={(event) => onChange({ quotamb: Number(event.target.value) })}
          >
            {quotaoptions.map((quota) => (
              <option key={quota} value={String(quota)}>
                {`${quota} MiB`}
              </option>
            ))}
          </select>
        </div>
        <p className="spec-hint">{cpuhint}</p>
      </div>
      <div className="spec-field">
        <label htmlFor="vcpurange">
          vcpus <span className="spec-val">{spec.vcpus}</span>
        </label>
        <input
          className="spec-range"
          id="vcpurange"
          type="range"
          min={1}
          max={192}
          value={spec.vcpus}
          disabled={disabled}
          aria-label="virtual cpu count"
          onChange={(event) => onChange({ vcpus: Number(event.target.value) })}
        />
      </div>
      <div className="spec-field">
        <label htmlFor="ramrange">
          ram (gb) <span className="spec-val">{spec.ramgb}</span>
        </label>
        <input
          className="spec-range"
          id="ramrange"
          type="range"
          min={1}
          max={ramceiling}
          value={spec.ramgb}
          disabled={disabled}
          aria-label="virtual memory in gigabytes, up to 18 tb"
          onChange={(event) => onChange({ ramgb: Number(event.target.value) })}
        />
        <label htmlFor="ramnum">exact ram (gb)</label>
        <input
          ref={ramnumref}
          className="spec-select spec-number"
          id="ramnum"
          type="number"
          min={1}
          max={ramceiling}
          value={ramdraft}
          disabled={disabled}
          aria-label="exact virtual memory in gigabytes"
          onChange={(event) => onramnuminput(event.target.value)}
        />
      </div>
      <div className="spec-field">
        <label htmlFor="gpusel">gpu</label>
        <select
          className="spec-select"
          id="gpusel"
          disabled={disabled}
          aria-label="virtual gpu model"
          value={spec.gpu}
          onChange={(event) => onChange({ gpu: event.target.value })}
        >
          {gpudata.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {`${entry.name} (${entry.memtype} ${entry.vrammib / 1024} gb)`}
            </option>
          ))}
        </select>
        <p className="spec-hint">{gpuhint}</p>
      </div>
      <div className="spec-field">
        <label htmlFor="migsel">vram mig profile</label>
        <select
          className="spec-select"
          id="migsel"
          disabled={disabled}
          aria-label="gpu mig slicing profile"
          value={spec.mig}
          onChange={(event) => onChange({ mig: event.target.value })}
        >
          {migoptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
