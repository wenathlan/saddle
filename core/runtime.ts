/**
 * runtime records describe temporary process space without claiming physical vram.
 */
export function workingset(jobid, location, resultpath, createdat = Date.now()) {
  return { jobid, location, resultpath, createdat };
}

export function syncresult(bytes, location) {
  return { bytes, location };
}
