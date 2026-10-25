# oneclient-pipeline

Build your own test scenarios as pipelines — the same shape as a CI/CD job: ordered steps, variables, retries,
teardown. Add a **Pipelines** connection (a workspace; it needs no server), then create a pipeline from the sidebar
or start from **New Example Pipeline**.

```
Run script (PowerShell) → Start test container → Seed data → Call REST API → Check the result → Clean up
```

## Steps

| Step | What it does |
| --- | --- |
| **Run script** | PowerShell, pwsh, bash, sh or cmd. A non-zero exit fails the step. Print `::set name=value` to create a variable. |
| **Test container** | Starts any image through the Docker plugin (its *Test Containers* feature), waits for a port / log line / health check, and exposes the endpoints. Removed when the run ends, even on failure. |
| **HTTP request** | Any method, headers, body; expected status (`2xx`, `200,404`, `any`); keep values from the response. |
| **Plugin command** | Calls a command another plugin lists as a tool (`oneclient.aiTools`) — the generic bridge to other plugins. |
| **Wait / Set variables / Check values** | Pause, define variables, assert on variables. |

Every step that produces something can **Then check** it: HTTP status, a JSON value (`data.items[0].id`), the body, a
header, the duration, a script's exit code or output, or a variable — equals, contains, matches a regex, greater/less
than, exists.

## Variables

`{{name}}` anywhere in a step. Double braces, so `${HOME}` and `$(date)` reach your shell untouched.

- Pipeline variables (Variables tab). Mark one **secret** to keep it in the secret store and mask it in logs.
- Step outputs: `{{steps.<id>.<output>}}`. A test container gives `endpoint`, `host`, `port`, `name`, `containerId`
  and, per port, `endpoint.5432`, `port.5432`, `host.5432`. HTTP gives `status`, `body`, `durationMs`; a script gives
  `output`, `exitCode`.
- Built-ins: `{{$guid}}`, `{{$timestamp}}`, `{{$random}}`. Fallback: `{{name:-default}}`.
- A variable that is not defined stops the step with an error — never an empty string.

## Behaviour

- Steps run in order; a failure skips the rest, except steps set to run **always** (teardown) or on **failure**.
- **Continue even if this step fails** records the failure without failing the run.
- **Retries** and a **timeout** per step — poll a service until it answers.
- **Stop** cancels the running step; teardown still runs.
- Containers a run started are removed at the end (unless **Leave it running** is ticked).
- The run shows live in the editor and in the **Tasks** panel; the last 20 runs of each pipeline are kept.
- The **JSON** tab shows the whole pipeline — copy it to share a scenario, paste one to import it.

Pipelines are stored in `~/.oneclient/pipeline/<connection id>.json` (or under `$ONECLIENT_HOME`).

## Needs

The Docker plugin for container steps (it lists `docker_run_test_container`, `docker_remove_container` and
`docker_cleanup_test_containers` as tools, which is how this plugin reaches it). Everything else is built in.
