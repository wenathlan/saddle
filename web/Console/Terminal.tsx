// Terminal: faithful absorption of the console.html terminal — animated boot
// output (rows appended by the console page), command history with the arrow
// keys, tab completion over the sandbox command list, the live prompt and
// the focus-on-click output pane.
import { useEffect, useRef, useState } from "react";
import { commands } from "../sandbox.ts";

/** one rendered output row; cls mirrors the static page row classes. */
export type TerminalRow = {
  id: number;
  text: string;
  cls: string;
};

/** the terminal lifecycle label shown in the bar. */
export type TerminalState = "halted" | "booting" | "running" | "stopped";

type TerminalProps = {
  rows: TerminalRow[];
  prompt: string;
  state: TerminalState;
  enabled: boolean;
  oncommand: (command: string) => void;
};

/**
 * the virtual container terminal: a dark log pane (role=log, polite
 * aria-live), a command input with history browsing and tab completion,
 * and the status dots bar.
 */
export default function Terminal({ rows, prompt, state, enabled, oncommand }: TerminalProps) {
  const outref = useRef<HTMLPreElement>(null);
  const inputref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const historyref = useRef<string[]>([]);
  const historyindex = useRef(-1);

  /** keep the output pinned to the newest row, like scrollterm(). */
  useEffect(() => {
    const out = outref.current;
    if (out) out.scrollTop = out.scrollHeight;
  }, [rows]);

  /** focus the command input once the sandbox is running. */
  useEffect(() => {
    if (enabled) inputref.current?.focus();
  }, [enabled]);

  const onsubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled) return;
    const trimmed = value.trim();
    setValue("");
    if (trimmed.length === 0) return;
    historyref.current.push(trimmed);
    historyindex.current = historyref.current.length;
    oncommand(trimmed);
  };

  const onkeydown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (historyref.current.length === 0) return;
      historyindex.current = Math.max(0, historyindex.current - 1);
      setValue(historyref.current[historyindex.current] ?? "");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyref.current.length === 0) return;
      historyindex.current = Math.min(historyref.current.length, historyindex.current + 1);
      setValue(historyref.current[historyindex.current] ?? "");
    } else if (event.key === "Tab") {
      event.preventDefault();
      const prefix = value.trim();
      if (prefix.length === 0) return;
      const match = commands.find((entry) => entry.startsWith(prefix));
      if (match !== undefined) setValue(match);
    }
  };

  return (
    <section className="term" aria-labelledby="termtitle">
      <div className="term-bar">
        <span className="term-dots" aria-hidden="true">
          <span className="term-dot on" />
          <span className="term-dot on" />
          <span className="term-dot" />
        </span>
        <span id="termtitle">root@saddle — virtual container</span>
        <span className="term-state" aria-live="polite">
          {state}
        </span>
      </div>
      <pre
        className="term-out"
        role="log"
        aria-live="polite"
        aria-label="sandbox terminal output"
        ref={outref}
        onClick={() => inputref.current?.focus()}
      >
        {rows.map((row) => (
          <span key={row.id} className={row.cls === "" ? undefined : row.cls}>
            {row.text}
            {"\n"}
          </span>
        ))}
      </pre>
      <form className={enabled ? "term-in" : "term-in off"} onSubmit={onsubmit}>
        <label className="term-prompt" htmlFor="termin">
          {prompt}
        </label>
        <input
          id="termin"
          ref={inputref}
          className="term-input"
          autoComplete="off"
          spellCheck={false}
          aria-label="terminal command input; arrow keys browse history"
          disabled={!enabled}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onkeydown}
        />
      </form>
    </section>
  );
}
