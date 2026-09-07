// Signal & Ledger: a tabela de nós do mesh absorvida do dashboard.js —
// ping pela rota assinada /api/v1/mesh/ping com fallback para a sonda de
// latência do navegador; no edge estático, a linha "this browser".
import { useEffect, useState } from "react";
import { apiresult, asarray, chipclass, fmtdate, pick } from "./lib";

type MeshNodesTableProps = {
  /** "api" lists /api/v1/admin/nodes; "local" renders the browser row. */
  mode: "api" | "local";
  /** bumped by the admin refresh-all action. */
  reloadkey: number;
};

/** one ping outcome per node url. */
type PingState = { busy: boolean; result: string };

/**
 * pings one mesh node: the primary contract posts /api/v1/mesh/ping (the
 * server-side signed mesh); when the node does not expose it the browser
 * falls back to a latency probe of the node health endpoint.
 */
async function meshping(url: string): Promise<string> {
  try {
    const post = await apiresult("/api/v1/mesh/ping", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    if (post.ok) {
      const rtt = pick(post.body, ["rttMs", "rtt", "latencyMs", "latency"], null);
      return rtt !== null ? `pong ${String(rtt)} ms (mesh)` : "pong (mesh)";
    }
  } catch {
    /* fall through to the client probe */
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 4000);
    const started = performance.now();
    await fetch(`${String(url).replace(/\/+$/, "")}/api/v1/health`, {
      mode: "no-cors",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return `pong ~${Math.max(1, Math.round(performance.now() - started))} ms (client probe)`;
  } catch {
    return "unreachable";
  }
}

export default function MeshNodesTable({ mode, reloadkey }: MeshNodesTableProps) {
  const [nodes, setnodes] = useState<unknown[]>([]);
  const [error, seterror] = useState("");
  const [pings, setpings] = useState<Record<string, PingState>>({});

  useEffect(() => {
    if (mode !== "api") {
      return undefined;
    }
    let stopped = false;
    (async () => {
      try {
        const result = await apiresult("/api/v1/admin/nodes");
        if (stopped) {
          return;
        }
        if (!result.ok) {
          setnodes([]);
          seterror(`node table unavailable (status ${result.status}).`);
          return;
        }
        seterror("");
        setnodes(asarray(result.body, ["nodes", "items", "data", "list"]));
      } catch {
        if (!stopped) {
          seterror("the nodes endpoint is unreachable.");
        }
      }
    })();
    return () => {
      stopped = true;
    };
  }, [mode, reloadkey]);

  /** runs one ping and paints the result cell beside the button. */
  function runping(url: string) {
    setpings((previous) => ({ ...previous, [url]: { busy: true, result: "pinging..." } }));
    void meshping(url).then((result) => {
      setpings((previous) => ({ ...previous, [url]: { busy: false, result } }));
    });
  }

  return (
    <div>
      <p className="dash-statusnote">
        ping goes through /api/v1/mesh (hmac signed server side); this page never holds mesh keys.
      </p>
      <div className="dash-tablescroll" tabIndex={0} role="region" aria-label="mesh nodes table">
        <table>
          {mode === "api" && nodes.length === 0 && error === "" && (
            <caption className="dash-empty">no nodes registered yet.</caption>
          )}
          <thead>
            <tr>
              <th scope="col">url</th>
              <th scope="col">region</th>
              <th scope="col">status</th>
              <th scope="col">last heartbeat</th>
              <th scope="col">ping</th>
            </tr>
          </thead>
          <tbody>
            {mode === "local" ? (
              <tr>
                <td>this browser</td>
                <td>static edge (github pages / vercel / netlify clone)</td>
                <td>local</td>
                <td>n/a</td>
              </tr>
            ) : (
              nodes.map((node, index) => {
                const url = String(pick(node, ["url", "endpoint", "address", "host"], "?"));
                const region = String(pick(node, ["region", "location", "zone"], "-"));
                const status = String(pick(node, ["status", "state"], "?"));
                const heartbeat = pick(node, ["lastHeartbeat", "lastHeartbeatAt", "lastSeen", "last_heartbeat"], null);
                const pingstate = pings[url];
                return (
                  <tr key={`${url}-${index}`}>
                    <td className="wrapcell">{url}</td>
                    <td>{region}</td>
                    <td>
                      <span className={chipclass(status)}>{status}</span>
                    </td>
                    <td>{fmtdate(heartbeat)}</td>
                    <td>
                      <button
                        type="button"
                        className="mini"
                        aria-label={`ping mesh node ${url}`}
                        disabled={pingstate?.busy === true}
                        onClick={() => {
                          runping(url);
                        }}
                      >
                        ping
                      </button>{" "}
                      <span className="wrapcell" role="status" aria-live="polite">
                        {pingstate === undefined ? "-" : pingstate.result}
                      </span>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {error !== "" && <p className="dash-panelerror">{error}</p>}
    </div>
  );
}
