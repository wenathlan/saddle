// Signal & Ledger: a timeline de eventos do barramento absorvida do
// dashboard.js — poll de /api/v1/events?since= a cada 10 s com cursor,
// prepend e teto de 50 entradas; no edge estático vira a nota honesta.
import { useEffect, useRef, useState } from "react";
import { apiresult, asarray, fmtdate, pick } from "./lib";

type EventsTimelineProps = {
  /** "api" polls the bus; "local" shows the static-edge note. */
  mode: "api" | "local";
  /** false while the session bootstrap runs (avoids a premature 401). */
  ready: boolean;
};

/** one rendered timeline entry with the kind the left border encodes. */
type TimelineEntry = {
  key: string;
  kind: "lifecycle" | "exec" | "mesh";
  time: string;
  topic: string;
  detail: string;
};

/** classifies one topic into the timeline color kinds. */
function kindfor(topic: string): "lifecycle" | "exec" | "mesh" {
  if (/exec/i.test(topic)) {
    return "exec";
  }
  if (/mesh|node|ping/i.test(topic)) {
    return "mesh";
  }
  return "lifecycle";
}

/** projects one bus event into a rendered entry (defensive). */
function toentry(record: unknown, index: number): TimelineEntry {
  const topic = String(pick(record, ["topic", "type", "event", "name"], "event"));
  const detail = pick(record, ["detail", "data", "message", "payload"], "");
  const at = pick(record, ["at", "ts", "time", "createdAt", "created_at", "when"], null);
  return {
    key: `${String(pick(record, ["id", "seq"], index))}-${index}`,
    kind: kindfor(topic),
    time: fmtdate(at),
    topic,
    detail: typeof detail === "string" ? detail : JSON.stringify(detail),
  };
}

export default function EventsTimeline({ mode, ready }: EventsTimelineProps) {
  const [entries, setentries] = useState<TimelineEntry[]>([]);
  const cursorref = useRef("");

  useEffect(() => {
    if (mode !== "api" || !ready) {
      return undefined;
    }
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      try {
        const query = cursorref.current === "" ? "" : `?since=${encodeURIComponent(cursorref.current)}`;
        const result = await apiresult(`/api/v1/events${query}`);
        if (stopped || !result.ok) {
          return;
        }
        const items = asarray(result.body, ["events", "items", "data", "list"]);
        const lastid = pick(result.body, ["lastid", "lastId"], null);
        if (lastid !== null && lastid !== undefined) {
          cursorref.current = String(lastid);
        }
        if (items.length === 0) {
          return;
        }
        const projected = items.map((item, index) => {
          const next = pick(item, ["id", "seq"], null);
          if (next !== null && next !== undefined) {
            cursorref.current = String(next);
          }
          return toentry(item, index);
        });
        setentries((previous) => [...projected, ...previous].slice(0, 50));
      } catch {
        /* the next poll retries silently */
      }
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 10000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [mode, ready]);

  if (mode === "local") {
    return (
      <ol className="dash-timeline" role="log" aria-live="polite" aria-label="mesh bus event timeline">
        <li className="dash-empty">
          <span>bus events stream from the main node api; nothing to poll on the static edge.</span>
        </li>
      </ol>
    );
  }

  return (
    <div>
      <ol className="dash-timeline" role="log" aria-live="polite" aria-label="mesh bus event timeline">
        {entries.length === 0 && <li className="dash-empty">waiting for events...</li>}
        {entries.map((entry) => (
          <li key={entry.key} className={entry.kind}>
            <span className="time">{entry.time} </span>
            <span className="topic">{entry.topic}</span>
            <span className="detail">{entry.detail}</span>
          </li>
        ))}
      </ol>
      <p className="dash-statusnote">polls /api/v1/events every 10 s while the tab is visible.</p>
    </div>
  );
}
