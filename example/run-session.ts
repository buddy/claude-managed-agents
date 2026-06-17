/**
 * Interactive session runner. Creates a session against the agent + self-hosted
 * environment, then drops into a prompt loop: you type a prompt, it sends it,
 * waits for the transcript to go idle, and prints the agent's response. Submit
 * an empty line (or type `exit`) to quit.
 *
 * Requires a deployed + webhook-registered orchestrator (it does the dispatch).
 *
 *   npm run session
 */
import { input } from "@inquirer/prompts";
import Anthropic from "@anthropic-ai/sdk";

import { anthropicAdminClient, BETA } from "../src/clients.js";
import { requireAgentId, requireEnvironmentId } from "../src/config.js";
import { errLabel, sleep } from "../src/util.js";

const IDLE_TIMEOUT_MS = 180_000;

function isTerminal(ev: { type?: string }): boolean {
  const t = ev.type ?? "";
  return t.includes("status_idle") || t.includes("status_terminated") || t.includes("status_run_ended");
}

/**
 * Streams events until the transcript reaches a terminal state, collecting the
 * text of any `agent.message` events whose id we haven't seen before. `seen`
 * dedupes across turns in case the stream replays earlier events.
 */
async function waitForResponse(
  client: Anthropic,
  sessionId: string,
  seen: Set<string>,
): Promise<{ idle: boolean; text: string }> {
  const parts: string[] = [];

  const consume = (async () => {
    const stream = await client.beta.sessions.events.stream(sessionId);
    for await (const ev of stream as AsyncIterable<{ type?: string; id?: string; content?: Array<{ type?: string; text?: string }> }>) {
      if (ev.type === "agent.message" && ev.id && !seen.has(ev.id)) {
        seen.add(ev.id);
        for (const block of ev.content ?? []) {
          if (block.type === "text" && block.text) parts.push(block.text);
        }
      }
      if (isTerminal(ev)) return true;
    }
    return false;
  })();

  const timeout = sleep(IDLE_TIMEOUT_MS).then(() => false);
  const idle = await Promise.race([consume, timeout]);
  return { idle, text: parts.join("\n").trim() };
}

async function main(): Promise<void> {
  const client = anthropicAdminClient();
  const session = await client.beta.sessions.create({
    agent: requireAgentId(),
    environment_id: requireEnvironmentId(),
    betas: [BETA],
  });
  console.log(`session: ${session.id}`);
  console.log("Type a prompt and press Enter. Submit an empty line or `exit` to quit.\n");

  const seen = new Set<string>();

  for (;;) {
    const prompt = (await input({ message: "you:" })).trim();
    if (prompt === "" || prompt.toLowerCase() === "exit") break;

    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
    });

    const { idle, text } = await waitForResponse(client, session.id, seen);
    if (!idle) {
      console.log("(timed out waiting for the transcript to go idle)\n");
      continue;
    }
    console.log(`\nagent: ${text || "(no text response)"}\n`);
  }

  console.log("bye");
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});
