/**
 * Create a self-hosted Claude Managed Agents environment.
 * Prints ANTHROPIC_ENVIRONMENT_ID — add it to .env, then generate an
 * environment key in the Anthropic Console and set ANTHROPIC_ENVIRONMENT_KEY.
 *
 *   npm run create-environment
 */
import { anthropicAdminClient, BETA } from "../src/clients.js";
import { errLabel } from "../src/util.js";

async function main(): Promise<void> {
  const client = anthropicAdminClient();
  const env = await client.beta.environments.create({
    name: "buddy-sandboxes",
    config: { type: "self_hosted" },
    betas: [BETA],
  });
  console.log(`created environment ${env.id}`);
  console.log("");
  console.log(`ANTHROPIC_ENVIRONMENT_ID=${env.id}`);
  console.log("");
  console.log("Next: open the Anthropic Console > Managed Agents > Environments,");
  console.log("select this environment, click 'Generate environment key', and set");
  console.log("ANTHROPIC_ENVIRONMENT_KEY in .env.");
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});
