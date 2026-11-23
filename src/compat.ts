export const MIN_ANT_MAJOR = 2;
export const BASE_SNAPSHOT_PREFIX = "cma-base-v2-";

export function antVersionProblem(version: string): string | undefined {
  const major = Number(version.split(".")[0]);
  if (Number.isInteger(major) && major >= MIN_ANT_MAJOR) return undefined;
  return `ANT_VERSION=${version} is too old: workers read the work secret file, which needs ant ${MIN_ANT_MAJOR}.x or later`;
}

export function baseSnapshotProblem(
  snapshots: Array<{ id?: string; name?: string }>,
  snapshotId: string,
): string | undefined {
  const snapshot = snapshots.find((s) => s.id === snapshotId);
  if (!snapshot) {
    return `base snapshot ${snapshotId} not found; run npm run build-snapshot and update BUDDY_BASE_SNAPSHOT_ID`;
  }
  if (!snapshot.name?.startsWith(BASE_SNAPSHOT_PREFIX)) {
    return (
      `base snapshot ${snapshotId} (${snapshot.name ?? "unnamed"}) was built before workers moved to the ` +
      "work secret file; run npm run build-snapshot and update BUDDY_BASE_SNAPSHOT_ID"
    );
  }
  return undefined;
}
