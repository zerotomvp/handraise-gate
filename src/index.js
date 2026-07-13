// handraise-gate: block a workflow on a typed human approval delivered over Slack.
//
// Calls the Handraise MCP server's `request_feedback` tool (type: approval),
// then polls `fetch_response` until a human approves/rejects or the gate times out.
// Step succeeds only on approval; every other outcome fails the step, with the
// verdict exposed as an output so `if: always()` consumers can branch on it.

import * as core from "@actions/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// --- helpers ---------------------------------------------------------------

function parseToolResult(result, toolName) {
  if (result.isError) {
    const text = result.content?.[0]?.text ?? JSON.stringify(result.content);
    throw new Error(`${toolName} returned a tool error: ${text}`);
  }
  const text = result.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error(`${toolName} returned no text content: ${JSON.stringify(result.content)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${toolName} returned non-JSON text: ${text}`);
  }
}

// A terminal outcome of the gate. `verdict` is one of:
// approved | rejected | timed_out | cancelled | error
function outcome(verdict, message, extra = {}) {
  return { verdict, message, ...extra };
}

// Decide from a resolved request object; returns an outcome or null if still pending.
function settleIfTerminal(state) {
  const status = state.status ?? state.state;
  if (status === "pending") return null;

  if (status === "cancelled" || status === "canceled") {
    return outcome(
      "cancelled",
      `request was cancelled by the server${state.reason ? ` (${state.reason})` : ""}.`
    );
  }
  if (status === "expired" || status === "timeout" || status === "timed_out") {
    return outcome("timed_out", "request expired before anyone responded.");
  }

  // Resolved: the typed approval response is {approved: boolean, comment?: string}.
  const response = state.response ?? state.result ?? state;
  const approved = response?.approved ?? state.approved;
  const comment = response?.comment ?? state.comment;
  if (approved === true) {
    return outcome("approved", `approved by a human${comment ? ` (comment: ${comment})` : ""}.`, {
      comment,
    });
  }
  if (approved === false) {
    return outcome("rejected", `rejected by a human${comment ? ` (comment: ${comment})` : ""}.`, {
      comment,
    });
  }
  return outcome("error", `request finished in an unrecognized state: ${JSON.stringify(state)}`);
}

// Turn a thrown error into an infra "error" outcome with an actionable message.
function infraOutcome(prefix, err) {
  let message = `${prefix}: ${err.message}`;
  if (!/[.!?]$/.test(message)) message += ".";
  if (/\b401\b|unauthorized/i.test(err.message)) {
    message += " The server rejected the credentials. Check that the `token` input is set to a valid Handraise bearer token.";
  } else if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(err.message)) {
    message += " The Handraise MCP server was unreachable. Check the service status (and the `mcp-url` input if you overrode it).";
  }
  return outcome("error", message);
}

// --- gate ------------------------------------------------------------------

async function runGate() {
  const assignee = core.getInput("assignee", { required: true });
  const title = core.getInput("title") || "CI gate: proceed?";
  const token = core.getInput("token");
  const mcpUrl = core.getInput("mcp-url") || "https://handraise.hack.zmvp.dev/mcp";
  const summaryMd = core.getInput("summary-md");
  const timeoutMinutes = Number(core.getInput("timeout-minutes") || "10");
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return outcome("error", `timeout-minutes must be a positive number, got "${core.getInput("timeout-minutes")}".`);
  }
  const deadlineMs = timeoutMinutes * 60 * 1000;

  if (token) core.setSecret(token);

  // Slack section blocks render mrkdwn, not GitHub Markdown: *bold*, <url|label> links.
  const runMeta = [
    `*Repository:* ${process.env.GITHUB_REPOSITORY ?? "(local run)"}`,
    `*Run:* ${
      process.env.GITHUB_RUN_ID
        ? `<${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}|#${process.env.GITHUB_RUN_ID}>`
        : "(local run)"
    }`,
    `*Triggered by:* ${process.env.GITHUB_ACTOR ?? process.env.USER ?? "unknown"}`,
    `*Ref:* ${process.env.GITHUB_REF ?? "n/a"}`,
  ].join("\n");
  const summary = `${runMeta}${summaryMd ? `\n\n${summaryMd}` : ""}`;

  const client = new Client({ name: "handraise-gate", version: "1.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });

  core.info(`Connecting to Handraise MCP server at ${mcpUrl} ...`);
  try {
    await client.connect(transport);
  } catch (err) {
    return infraOutcome("could not connect to the Handraise MCP server", err);
  }

  core.info(`Requesting approval from ${assignee}: "${title}"`);
  const started = Date.now();

  try {
    let state;
    try {
      const result = await client.callTool({
        name: "request_feedback",
        arguments: {
          title,
          type: "approval",
          payload: { summary_md: summary },
          assignees: [assignee],
          timeout_s: 45,
          requester: {
            agent: "handraise-gate (GitHub Action)",
            origin: "action",
          },
        },
      });
      state = parseToolResult(result, "request_feedback");
    } catch (err) {
      return infraOutcome("request_feedback call failed", err);
    }

    // The initial call may already be terminal (fast tap, cancellation, error).
    let settled = settleIfTerminal(state);
    const requestId = state.request_id ?? state.id;
    if (settled) return { ...settled, requestId };

    if (!requestId) {
      return outcome("error", `server returned pending but no request_id: ${JSON.stringify(state)}`);
    }
    core.info(
      `Request ${requestId} is pending. A Slack card is on its way to ${assignee}. Waiting for a verdict...`
    );

    while (Date.now() - started < deadlineMs) {
      let result;
      try {
        result = await client.callTool({
          name: "fetch_response",
          arguments: { request_id: requestId, wait_s: 40 },
        });
      } catch (err) {
        return { ...infraOutcome("gate errored while waiting", err), requestId };
      }
      state = parseToolResult(result, "fetch_response");
      settled = settleIfTerminal(state);
      if (settled) return { ...settled, requestId };
      core.info(`Still pending (${Math.round((Date.now() - started) / 1000)}s elapsed)...`);
    }

    return outcome(
      "timed_out",
      `no response within ${timeoutMinutes} minutes. Treating as not approved.`,
      { requestId }
    );
  } finally {
    await client.close().catch(() => {});
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  let result;
  try {
    result = await runGate();
  } catch (err) {
    result = infraOutcome("gate errored unexpectedly", err);
  }

  const approved = result.verdict === "approved";

  // Set outputs BEFORE failing the step so `if: always()` consumers can branch.
  core.setOutput("verdict", result.verdict);
  core.setOutput("approved", approved ? "true" : "false");
  core.setOutput("comment", result.comment ?? "");
  core.setOutput("request-id", result.requestId ?? "");

  if (approved) {
    core.notice(`Gate PASSED: ${result.message}`);
  } else {
    core.setFailed(`Gate FAILED: ${result.message}`);
  }
}

main();
