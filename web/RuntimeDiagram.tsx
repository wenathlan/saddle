// Signal & Ledger: diagrama vivo de repo, runner e páginas como uma única cadeia de execução.
import { ArrowRight, CircleDot, Database, GitBranch, Globe2, Server } from "lucide-react";

const nodes = [
  { icon: GitBranch, label: "repo", detail: "persistent state", tone: "ink" },
  { icon: Server, label: "CI runner", detail: "virtual processor", tone: "ember" },
  { icon: Database, label: "memory", detail: "storage bridge", tone: "blue" },
  { icon: Globe2, label: "Pages / CDN", detail: "shared surface", tone: "sage" },
];

export default function RuntimeDiagram() {
  return (
    <div className="runtime-diagram" aria-label="Runtime chain diagram">
      <div className="diagram-topline">
        <span>BOOT SEQUENCE / 00:00:42</span>
        <span className="diagram-live"><CircleDot size={11} /> active path</span>
      </div>
      <div className="diagram-nodes">
        {nodes.map((node, index) => {
          const Icon = node.icon;
          return (
            <div className="diagram-node-wrap" key={node.label}>
              <div className={`diagram-node tone-${node.tone}`}>
                <Icon size={19} strokeWidth={1.7} />
                <div>
                  <strong>{node.label}</strong>
                  <small>{node.detail}</small>
                </div>
              </div>
              {index < nodes.length - 1 && <ArrowRight className="diagram-arrow" size={18} />}
            </div>
          );
        })}
      </div>
      <div className="diagram-footer">
        <span>usage flag: <b>process</b></span>
        <span>latency budget: <b>remote / explicit</b></span>
      </div>
    </div>
  );
}
