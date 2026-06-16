/**
 * Create a long-lived agent with the built-in CMA toolset enabled (bash, file
 * ops, web fetch/search). The `ant beta:worker run` worker executes these tools
 * inside the Buddy worker sandbox.
 *
 *   npm run create-agent
 */
import { anthropicAdminClient, BETA } from "../src/clients.js";
import { CONFIG } from "../src/config.js";
import { errLabel } from "../src/util.js";

const SANDBOX_TOOLS = ["bash", "read", "write", "edit", "glob", "grep"] as const;
const WEB_TOOLS = ["web_fetch", "web_search"] as const;

async function main(): Promise<void> {
  const client = anthropicAdminClient();
  const agent = await client.beta.agents.create({
    name: "Buddy Sandbox Agent",
    description: "Runs the built-in toolset inside a Buddy Sandbox microVM.",
    model: CONFIG.agentModel,
    system: "You have a working sandbox at /workspace. Use your tools to do what is asked. Be terse.",
    tools: [
      {
        type: "agent_toolset_20260401" as const,
        default_config: { enabled: false, permission_policy: { type: "always_allow" as const } },
        configs: [...SANDBOX_TOOLS, ...WEB_TOOLS].map((name) => ({
          name,
          enabled: true,
          permission_policy: { type: "always_allow" as const },
        })),
      },
    ],
    betas: [BETA],
  });
  console.log(`created agent ${agent.id} (model: ${CONFIG.agentModel})`);
  console.log("");
  console.log(`ANTHROPIC_AGENT_ID=${agent.id}`);
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});
