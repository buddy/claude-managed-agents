/**
 * Build the base worker snapshot: a Buddy sandbox with the `ant` CLI installed,
 * captured as a snapshot that every per-session worker is born from. Idempotent
 * only in that it always creates a fresh snapshot; delete old ones manually.
 *
 *   npm run build-snapshot
 */
import { Sandbox } from "@buddy-works/sandbox-sdk";

import { buddyConnection } from "../src/clients.js";
import { CONFIG } from "../src/config.js";
import { errLabel } from "../src/util.js";

// Runs as the `buddy` user (passwordless sudo). `dpkg --print-architecture`
// yields amd64/arm64, which is verbatim how the published assets are named
// (`ant_<version>_linux_<arch>.tar.gz`), so no arch translation table is needed.
// Verified against the v1.23.0 release assets; re-check both when bumping
// ANT_VERSION (see GUIDE.md, "Upgrading the `ant` CLI").
const ANT_INSTALL = [
  "set -eux",
  'ARCH="$(dpkg --print-architecture)"',
  `curl -fsSL "https://github.com/anthropics/anthropic-cli/releases/download/v${CONFIG.antVersion}/ant_${CONFIG.antVersion}_linux_\${ARCH}.tar.gz" | sudo tar -xz -C /usr/local/bin ant`,
  "sudo chmod +x /usr/local/bin/ant",
  `sudo mkdir -p ${CONFIG.workspaceDir}`,
  `sudo chown buddy:buddy ${CONFIG.workspaceDir} || true`,
  "ant --version",
].join("\n");

async function main(): Promise<void> {
  const stamp = Date.now();
  console.log(`creating base builder sandbox (ant ${CONFIG.antVersion})...`);
  const sb = await Sandbox.create({
    name: "cma-base-builder",
    identifier: `cma-base-builder-${stamp}`,
    os: "ubuntu:24.04",
    resources: CONFIG.workerResources,
    first_boot_commands: ANT_INSTALL,
    tags: ["cma", "cma-base"],
    connection: buddyConnection(),
  });

  try {
    console.log("verifying ant is on PATH...");
    const probe = await sb.runCommand({ command: "ant --version", runtime: "BASH" });
    if (probe.data.status !== "SUCCESSFUL") {
      const err = await sb.runCommand({ command: "ant --version", runtime: "BASH" }).then((c) => c.stderr());
      throw new Error(`ant not runnable in base image: ${err}`);
    }

    console.log("creating snapshot...");
    const snap = await sb.createSnapshot({ name: `cma-base-${stamp}` });
    await snap.waitUntilReady();

    console.log(`created snapshot ${snap.id}`);
    console.log("");
    console.log(`BUDDY_BASE_SNAPSHOT_ID=${snap.id}`);
  } finally {
    console.log("destroying builder sandbox...");
    await sb.destroy().catch((e) => console.warn(`builder destroy failed: ${errLabel(e)}`));
  }
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});
