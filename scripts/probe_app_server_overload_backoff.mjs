import fs from "node:fs/promises";
import path from "node:path";
import { runTurnAndRead } from "./lib/app_server_jsonrpc.mjs";

const workspace = "/Users/mymac/my dev/remodex";
const verificationDir = path.join(workspace, "verification");
const summaryPath = path.join(verificationDir, "app_server_overload_backoff_probe_summary.json");

const summary = {
  startedAt: new Date().toISOString(),
  turnStartAttempts: 0,
  result: null,
};

const client = {
  async request(method) {
    if (method === "turn/start") {
      summary.turnStartAttempts += 1;
      if (summary.turnStartAttempts < 3) {
        throw new Error("queue overloaded (-32001)");
      }
      return {
        turn: { id: "turn-overload-probe-001" },
      };
    }

    if (method === "thread/read") {
      return {
        thread: {
          turns: [
            {
              id: "turn-overload-probe-001",
              status: "completed",
              items: [
                {
                  type: "agentMessage",
                  text: "backoff-ok",
                },
              ],
            },
          ],
        },
      };
    }

    throw new Error(`unexpected method ${method}`);
  },

  async waitForNotification() {
    throw new Error("timeout waiting for turn/completed");
  },
};

try {
  await fs.mkdir(verificationDir, { recursive: true });
  summary.result = await runTurnAndRead(client, "thread-overload-probe-001", "hello", 5_000, {
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 20,
  });
  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.turnStartAttempts === 3 &&
    summary.result?.turnId === "turn-overload-probe-001" &&
    summary.result?.turnStartAttempts === 3 &&
    summary.result?.text === "backoff-ok"
      ? "PASS"
      : "FAIL";
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.finishedAt = new Date().toISOString();
  summary.status = "FAIL";
  summary.error = error instanceof Error ? error.message : String(error);
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
}
