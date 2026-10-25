# oneclient-docker

Connects to the local Docker Engine (named pipe on Windows, Unix socket elsewhere) or a remote one (`tcp://host:2375`),
through [`dockerode`](https://github.com/apocas/dockerode).

- **Explorer:** Containers, Images, Volumes, Networks and **Templates**.
- **Dashboard** (Tier 2 view): containers with Start / Stop / Restart / Logs / Remove, images with Pull, and the
  Templates gallery.
- **Commands:** start, stop, restart and remove containers; pull an image; create a connection for a container; run a
  template.

## Templates: infrastructure for testing, with a ready connection

**Templates** lists a container recipe for every installed plugin that has one: PostgreSQL, SQL Server, Redis, Kafka,
Azurite (Azure Blob Storage) and Keycloak. Clicking one opens a small form with fields already filled in:

- the container name,
- free host ports,
- a generated password,
- the connection name.

**Run & connect** then:

1. pulls the image if needed, with download progress in the **Tasks** panel;
2. creates and starts the container, labelled `oneclient.template=<plugin>/<id>`;
3. waits until the owning plugin's own connection test passes — the real readiness check, not a log line;
4. saves that plugin's connection, which appears in its sidebar right away.

If the container exits, the task fails with its last log lines. If it doesn't become reachable within the template's
`startupSeconds`, the task fails too, and the container is left running so you can inspect it.

## Test containers: any image, for special scenarios

The **Test Containers** tab (and sidebar node) runs a throwaway container from any image, in the spirit of
Testcontainers, when no template fits:

- **Image, name, command** — the command overrides the image default (quotes are honoured).
- **Ports** — `8080` publishes on a random free host port, `9090:8080` on a fixed one, `53/udp` for UDP. The endpoint
  Docker picked is reported when the container is ready.
- **Environment** — `KEY=VALUE` per line.
- **Wait until ready** — a published port accepts connections, a log line appears, or the image's health check passes.
  If the container exits or the timeout passes, the task fails with the last log lines.
- **Cleanup** — remove after N minutes, remove as soon as it exits, or **Remove all**. Every one is labelled
  `oneclient.testcontainer`; expired ones are removed while a Docker connection is open.

## Containers know their plugin

Every container whose image a template recognises shows its product and its connection:

```
oneclient-postgres-test   running · PostgreSQL → Shop database
oneclient-keycloak-test   running · Keycloak
```

- **Recognising the image:** it was started from a template (the label), or it matches the template's
  `imagePatterns`. That covers `postgres`, `postgis/postgis`, `bitnami/redis`, `confluentinc/cp-kafka`…
- **Finding the connection:** a saved connection of the plugin's type mentions one of the container's published host
  ports.

A recognised container without a connection gets **Create Connection for Container** (right-click, or the button on
its dashboard card). The credentials are read back from the container, using the template's `variables[].from`: an
env var, or the argument after a flag such as `--requirepass`. The connection is tested and then saved.

## Contributing a template (for plugin authors)

Templates belong to the plugin that owns the connection type. Add one to your manifest, and the Docker plugin picks it
up with no code change:

```jsonc
"contributes": {
  "icons": [{ "id": "postgresql", "description": "PostgreSQL", "path": "icon.svg", "colored": true }],
  "extensions": {
    "docker.containerTemplates": [{
      "id": "postgres",                       // unique within your plugin
      "title": "PostgreSQL 17",
      "product": "PostgreSQL",                // shown next to matching containers
      "description": "…",
      "icon": "$(postgresql)",                // a registry icon (contributes.icons)
      "image": "postgres:17",
      "imagePatterns": ["^(docker\\.io/)?(library/)?postgres([:@]|$)", "postgis/postgis"],
      "ports": [{ "container": "5432/tcp", "host": 5432, "label": "PostgreSQL" }],
      "env": { "POSTGRES_PASSWORD": "${password}" },
      "cmd": ["…"],                           // optional
      "variables": {
        "password": { "label": "Password", "secret": true, "from": [{ "env": "POSTGRES_PASSWORD" }] }
      },
      "connection": {
        "typeId": "postgres",
        "name": "Local PostgreSQL",
        "config": { "host": "${host}", "port": "${port}", "user": "postgres", "password": "${password}" }
      },
      "startupSeconds": 90
    }]
  }
}
```

**Placeholders** (in `env`, `cmd` and `connection.config`):

| Placeholder | Becomes |
|---|---|
| `${host}` | Where the published ports are reachable from this machine (`127.0.0.1` for a local engine). |
| `${port}` / `${port:5432/tcp}` | The host port of the first port entry, or of the named one. A value that is only this placeholder becomes a number. |
| `${name}` | The container name. |
| `${<variable>}` | A template variable. |

**Variables:**
- `secret` ones are masked in the form and, when they have no `default`, generated. The password generator meets SQL
  Server's complexity rules.
- `from` lists where to read the value back from an existing container: `{ "env": "NAME" }` or
  `{ "argAfter": "--flag" }`.

Secrets are stored by the target plugin as usual: any `connection.config` field its schema marks `"x-secret": true` goes
to the secret store.

## Code

| File | What |
|---|---|
| `src/templates.ts` | Pure template logic: matching, placeholders, create options, linking connections. Unit-tested in `test/templates.test.ts` against the real manifests. |
| `src/infra.ts` | The Docker side: pull with progress, run, readiness wait, connect to an existing container, free ports. |
| `src/explorer-provider.ts` | The tree, including container descriptions. |
| `src-ui/components/TemplatesPanel.tsx` | The Templates gallery. |
