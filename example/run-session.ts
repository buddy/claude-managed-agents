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

import { anthropicAdminClient, BETA } from "../src/clients.ts";
import { requireAgentId, requireEnvironmentId } from "../src/config.ts";
import { errLabel } from "../src/util.ts";

const TURN_TIMEOUT_MS = 180_000;
const DEBUG = !!process.env.DEBUG; // DEBUG=1 npm run session -> logs every event

interface StreamEvent {
  type?: string;
  id?: string;
  tool_use_id?: string;
  custom_tool_use_id?: string;
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
        // Custom-tool events key off `custom_tool_use_id`; everything else off
        // `id`. Track whichever this event carries so the matching result can
        // clear it — see the symmetric lookup in the result branch below.
        const id = raw.custom_tool_use_id ?? raw.id;
        if (id) pending.add(id);
      } else if (
        type === "agent.tool_result" ||
        type === "agent.mcp_tool_result" ||
        type === "user.tool_result" ||
        type === "user.custom_tool_result"
      ) {
        // In this self-hosted setup the worker posts results back as
        // `user.tool_result` / `user.custom_tool_result`, not `agent.*`.
        // Match the id field to whichever the tool_use event added above.
        const id = raw.custom_tool_use_id ?? raw.tool_use_id;
        if (id) pending.delete(id);
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

  const TIMEOUT = Symbol("timeout");
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

      // Cancelable timeout: clear the timer once the turn settles so a finished
      // turn doesn't leave a dangling 180s timer keeping the process alive.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), TURN_TIMEOUT_MS);
      });
      const result = await Promise.race([turnDone, timeout]);
      clearTimeout(timer);
      if (result === TIMEOUT) {
        awaiting = false;
        turn.resolve = null;
        console.log("(timed out waiting for the turn to finish)\n");
        continue;
      }
      console.log(`\nagent: ${result || "(no text response)"}\n`);
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
