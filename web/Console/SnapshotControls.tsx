// Snapshot controls: faithful absorption of the console.html snapshot/stop
// buttons — both stay disabled until a sandbox is running.
type SnapshotControlsProps = {
  running: boolean;
  onsnapshot: () => void;
  onstop: () => void;
};

/** the snapshot and teardown buttons of the running sandbox. */
export default function SnapshotControls({ running, onsnapshot, onstop }: SnapshotControlsProps) {
  return (
    <>
      <button
        className="button"
        type="button"
        disabled={!running}
        onClick={onsnapshot}
        aria-label="create a snapshot of the running sandbox"
      >
        snapshot
      </button>
      <button
        className="button"
        type="button"
        disabled={!running}
        onClick={onstop}
        aria-label="stop the running sandbox"
      >
        stop
      </button>
    </>
  );
}
