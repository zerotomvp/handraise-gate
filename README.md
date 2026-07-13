# Handraise Gate

A GitHub Action that blocks a workflow on a typed human approval in Slack. The action asks the [Handraise](https://github.com/zerotomvp/handraise) service to deliver a native approval card to a named person, waits for their tap, and resumes the workflow with the verdict.

The verdict is typed, not a comment to parse: `{approved: boolean, comment?: string}`. Approved means the step succeeds and the workflow proceeds. Rejected, timed out, or cancelled means the step fails, with the outcome exposed as an output you can branch on.

## Quickstart

```yaml
- name: wait for approval in Slack
  id: gate
  uses: zerotomvp/handraise-gate@v1
  with:
    assignee: you@example.com
    title: "Deploy to production?"
    token: ${{ secrets.HANDRAISE_TOKEN }}

# Only reached if the gate was approved.
- name: deploy
  run: ./deploy.sh
```

The `assignee` is a Slack user id, `@handle`, or email in your Handraise workspace. The card shows the repository, run link, actor, and ref, so the approver knows exactly what they are approving.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `assignee` | yes | | Who approves: Slack user id, `@handle`, or email. |
| `title` | no | `CI gate: proceed?` | What the approver is asked. |
| `token` | no | | Handraise bearer token authorizing request creation. Store it as a repo secret. |
| `timeout-minutes` | no | `10` | How long the gate waits for a verdict before failing as `timed_out`. |
| `summary-md` | no | | Extra markdown appended to the run metadata on the approval card. |
| `mcp-url` | no | hosted endpoint | See [Self-hosted / advanced](#self-hosted--advanced). |

## Outputs

| Output | Description |
| --- | --- |
| `verdict` | `approved`, `rejected`, `timed_out`, `cancelled`, or `error`. |
| `approved` | `"true"` if a human approved, otherwise `"false"`. |
| `comment` | The approver's comment, if any. |
| `request-id` | The Handraise request id, for auditing against the ledger. |

Outputs are set before the step fails, so `if: always()` steps can read them on any outcome.

## Branching on rejection

The gate step fails on anything other than approval, but downstream steps can still distinguish a human "no" from a timeout or an infrastructure error:

```yaml
- name: wait for approval in Slack
  id: gate
  uses: zerotomvp/handraise-gate@v1
  with:
    assignee: you@example.com
    token: ${{ secrets.HANDRAISE_TOKEN }}

- name: handle rejection
  if: always() && steps.gate.outputs.verdict == 'rejected'
  run: |
    echo "Rejected by a human: ${{ steps.gate.outputs.comment }}"
    # e.g. notify the channel, open an issue, roll back a canary

- name: handle timeout
  if: always() && steps.gate.outputs.verdict == 'timed_out'
  run: echo "Nobody answered in time. Not deploying."
```

## Honest note: this burns a runner

While the gate waits, a hosted runner sits occupied, up to `timeout-minutes`. That is an acceptable cost for many pipelines, but it is not the end-state design.

Roadmap: the same gate as a GitHub [deployment protection rule](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment#deployment-protection-rules). The workflow pauses runner-free at an environment boundary, Handraise resolves the approval in Slack, and a callback resumes the deployment. Same typed verdict, zero runner-minutes spent waiting.

## Self-hosted / advanced

The action talks to Handraise over MCP (streamable HTTP). By default it uses the hosted endpoint at `https://handraise.hack.zmvp.dev/mcp`. If you run your own Handraise server, point the action at it:

```yaml
- uses: zerotomvp/handraise-gate@v1
  with:
    assignee: you@example.com
    token: ${{ secrets.HANDRAISE_TOKEN }}
    mcp-url: https://handraise.your-company.dev/mcp
```

The server must expose the `request_feedback` and `fetch_response` tools with the approval schema described above.

## Development

```sh
npm install
npm run build   # bundles src/index.js to dist/index.js with esbuild
```

`dist/index.js` is committed; the `check-dist` workflow verifies it matches the source on every push.

## License

MIT
