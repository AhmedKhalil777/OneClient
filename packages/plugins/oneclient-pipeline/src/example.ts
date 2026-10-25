import type { Pipeline } from "./model.js";

/**
 * A pipeline that works with nothing but Docker: start nginx, call it, check the answer. `dockerConnectionId` may be
 * empty — the editor then asks the user to pick one.
 */
export function examplePipeline(dockerConnectionId: string): Omit<Pipeline, "id" | "updatedAt"> {
  return {
    name: "Example: web server smoke test",
    description: "Starts nginx in a test container, calls it over HTTP and checks the response. The container is removed at the end.",
    variables: [{ name: "greeting", value: "Welcome to nginx" }],
    steps: [
      { id: "tools", name: "Check the toolchain", kind: "shell", shell: "auto", script: "docker version\n" },
      {
        id: "web",
        name: "Start nginx",
        kind: "container",
        action: "run",
        connectionId: dockerConnectionId,
        image: "nginx:alpine",
        ports: ["80"],
        wait: { kind: "port" },
        waitTimeoutSeconds: 60,
      },
      {
        id: "home",
        name: "GET the home page",
        kind: "http",
        method: "GET",
        url: "http://{{steps.web.endpoint}}/",
        expectStatus: "200",
        // The container's port opens a moment before nginx answers: wait for it, retry if it doesn't.
        timeoutSeconds: 8,
        retries: 4,
        retryDelaySeconds: 2,
        assertions: [
          { target: "status", op: "equals", value: "200" },
          { target: "body", op: "contains", value: "{{greeting}}" },
          { target: "duration", op: "lt", value: "2000" },
        ],
      },
      {
        id: "missing",
        name: "Unknown path returns 404",
        kind: "http",
        method: "GET",
        url: "http://{{steps.web.endpoint}}/does-not-exist",
        expectStatus: "404",
        assertions: [{ target: "header", path: "content-type", op: "contains", value: "text/html" }],
      },
    ],
  };
}
