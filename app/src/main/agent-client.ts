// agent-client.ts — app→reader command/response protocol via shared files.
// The reader (agent_windows.py in dev, or a future meter loop) watches
// <outputDir>/agent/agent_cmd.json and replies to agent_resp.json.
// Returns null immediately when the agent isn't running (no cmd file).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Protocol types (mirrors reader/agent_windows.py)
// ---------------------------------------------------------------------------

interface AgentCommand {
  id: number;
  op: string;
}

interface AgentResponse {
  id: number;
  op: string;
  ms: number;
  result: unknown;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const POLL_MS = 300;
const TIMEOUT_MS = 30_000;

let _id = 0;
function nextId(): number {
  _id += 1;
  return _id;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a command to the running agent and wait for the response.
 * Returns the agent's result, or null when the agent isn't running or
 * the command timed out. Best-effort — never throws.
 */
export async function sendAgentCommand(
  outputDir: string,
  op: string,
  timeoutMs = TIMEOUT_MS,
): Promise<unknown | null> {
  const agentDir = join(outputDir, "agent");
  const cmdPath = join(agentDir, "agent_cmd.json");
  const respPath = join(agentDir, "agent_resp.json");

  // Agent not running → no cmd file to write to
  if (!existsSync(cmdPath)) return null;

  const id = nextId();
  const cmd: AgentCommand = { id, op };

  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(cmdPath, JSON.stringify(cmd), "utf-8");
  } catch {
    return null;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = readFileSync(respPath, "utf-8");
      const resp = JSON.parse(raw) as AgentResponse;
      if (resp.id === id && resp.op === op) return resp.result;
    } catch {
      // file doesn't exist yet or partial write
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  return null; // timeout
}
