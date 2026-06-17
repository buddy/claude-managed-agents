/**
 * Interactive session runner. Creates a session against the agent + self-hosted
 * environment, then drops into a prompt loop: you type a prompt, it sends it,
 * waits for the agent to finish the turn, and prints the response. Submit an
 * empty line (or type `exit`) to quit.
 *
 * A single long-lived event stream is opened once and consumed by a background
 * reader. A turn is considered finished only when the transcript goes idle AND
 * no tool call is still outstanding — the session parks on `idle` mid-turn while
 * the orchestrator dispatches a tool to the worker, so plain "idle" is not the
 * end of the turn.
 *
 * Requires a deployed + webhook-registered orchestrator (it does the dispatch).
 *
 *   npm run session
 */
import { input } from "@inquirer/prompts";

import { anthropicAdminClient, BETA } from "../src/clients.js";
import { requireAgentId, requireEnvironmentId } from "../src/config.js";
import { errLabel, sleep } from "../src/util.js";

const TURN_TIMEOUT_MS = 180_000;
const DEBUG = !!process.env.DEBUG; // DEBUG=1 npm run session -> logs every event

interface StreamEvent {
  type?: string;
  id?: string;
  tool_use_id?: string;
  content?: Array<{ type?: string; text?: string }>;
}

function isIdle(type: string): boolean {
  return type.includes("status_idle") || type.includes("status_terminated") || type.includes("status_run_ended");
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

  const stream = await client.beta.sessions.events.stream(session.id);

  // Per-turn state, reset by the input loop before each send.
  let awaiting = false; // are we currently waiting for a turn to finish?
  let sawActivity = false; // have we seen the agent start working since the send?
  const pending = new Set<string>(); // outstanding tool_use ids (turn isn't done until empty)
  let collected: string[] = []; // agent.message text gathered this turn
  const turn: { resolve: ((text: string) => void) | null } = { resolve: null };

  // Background reader: a single pass over the whole session stream.
  const reader = (async () => {
    for await (const raw of stream as AsyncIterable<StreamEvent>) {
      const type = raw.type ?? "";
      if (DEBUG) {
        const textLen = (raw.content ?? []).reduce((n, b) => n + (b.text?.length ?? 0), 0);
        console.log(`[ev]${awaiting ? "" : " (ignored)"} ${type}${textLen ? ` text=${textLen}` : ""}`);
      }
      if (!awaiting) continue; // ignore startup replay and between-turn chatter

      if (type === "session.status_running" || type.startsWith("agent.")) sawActivity = true;

      if (type === "agent.message") {
        for (const block of raw.content ?? []) {
          if (block.type === "text" && block.text) collected.push(block.text);
        }
      } else if (type === "agent.tool_use" || type === "agent.custom_tool_use" || type === "agent.mcp_tool_use") {
        if (raw.id) pending.add(raw.id);
      } else if (type === "agent.tool_result" || type === "agent.mcp_tool_result") {
        if (raw.tool_use_id) pending.delete(raw.tool_use_id);
      }

      // Turn is done only once we've seen the agent work AND every tool finished.
      if (sawActivity && pending.size === 0 && isIdle(type)) {
        const resolve = turn.resolve;
        awaiting = false;
        turn.resolve = null;
        if (resolve) resolve(collected.join("\n").trim());
      }
    }
  })();
  reader.catch((e) => console.error(`stream error: ${errLabel(e)}`));

  try {
    for (;;) {
      const prompt = (await input({ message: "you:" })).trim();
      if (prompt === "" || prompt.toLowerCase() === "exit") break;

      // Arm the state machine before sending so we don't miss fast events.
      collected = [];
      pending.clear();
      sawActivity = false;
      const turnDone = new Promise<string>((resolve) => {
        turn.resolve = resolve;
      });
      awaiting = true;

      await client.beta.sessions.events.send(session.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
      });

      const TIMEOUT = Symbol("timeout");
      const result = await Promise.race([turnDone, sleep(TURN_TIMEOUT_MS).then(() => TIMEOUT)]);
      if (result === TIMEOUT) {
        awaiting = false;
        turn.resolve = null;
        console.log("(timed out waiting for the turn to finish)\n");
        continue;
      }
      console.log(`\nagent: ${(result as string) || "(no text response)"}\n`);
    }
  } finally {
    stream.controller.abort();
  }

  console.log("bye");
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});
