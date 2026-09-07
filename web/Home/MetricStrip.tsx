// Signal & Ledger: métricas como evidência operacional, não como ornamento de dashboard.
type Metric = { value: string; label: string; detail: string };

export default function MetricStrip({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="metric-strip">
      {metrics.map((metric) => (
        <div className="metric" key={metric.label}>
          <span className="metric-value">{metric.value}</span>
          <span className="metric-label">{metric.label}</span>
          <span className="metric-detail">{metric.detail}</span>
        </div>
      ))}
    </div>
  );
}
