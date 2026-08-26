/**
 * artifacts are serializable manifests with content checksums.
 */
export function artifactmanifest(input) {
  return {
    key: input.key,
    sizebytes: input.sizebytes,
    sha256: input.sha256,
    contenttype: input.contenttype,
    createdat: input.createdat,
    metadata: { ...(input.metadata ?? {}) }
  };
}
