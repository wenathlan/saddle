// Signal & Ledger: trilho vertical que dá sequência operacional e orientação às seções.
type SectionRailProps = {
  number: string;
  label: string;
};

export default function SectionRail({ number, label }: SectionRailProps) {
  return (
    <div className="section-rail" aria-label={`${number} ${label}`}>
      <span className="rail-number">{number}</span>
      <span className="rail-line" />
      <span className="rail-label">{label}</span>
    </div>
  );
}
