// Api badge: faithful absorption of the console.html header badge — live
// detection label for the self-hosted api vs the local engine.
type ApiBadgeProps = {
  apion: boolean;
  label: string;
};

/** the engine-mode badge ("api connected (v..., uptime ...s)" or local). */
export default function ApiBadge({ apion, label }: ApiBadgeProps) {
  return (
    <span className={apion ? "api-badge apion" : "api-badge"} aria-live="polite">
      {label}
    </span>
  );
}
