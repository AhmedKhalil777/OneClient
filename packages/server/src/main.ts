#!/usr/bin/env node
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { InstanceLockError } from "@oneclient/backend/config/instance-lock.js";
import { ConfigVersionError, oneclientHome } from "@oneclient/backend/config/config-store.js";
import { loadToken } from "./auth.js";
import { startServer } from "./server.js";

const HELP = `oneClient web server — the oneClient workbench in your browser, on plain Node (no Electron).

Usage: oneclient-server [options]

  --port <n>        Port to listen on (default 4180, or $PORT)
  --host <addr>     Address to bind (default 127.0.0.1 — only this machine). Use 0.0.0.0 to serve your
                    network; then put it behind HTTPS (a reverse proxy) and keep the token secret.
  --home <dir>      Config folder (default ~/.oneclient, or $ONECLIENT_HOME)
  --plugins <dir>   Extra folder of plugins (repeatable; also $ONECLIENT_PLUGINS, separated by the OS path delimiter)
  --token <t>       Access token (default: $ONECLIENT_TOKEN, else generated once and kept in <home>/server-token)
  -h, --help        This help

Secrets are encrypted with a key in <home>/server.key (or $ONECLIENT_SECRET_KEY, 32 bytes hex/base64).
`;

function parseArgs(argv: string[]) {
  const opts = { port: Number(process.env.PORT) || 4180, host: process.env.HOST || "127.0.0.1", home: undefined as string | undefined, plugins: [] as string[], token: process.env.ONECLIENT_TOKEN };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value.`);
      return v;
    };
    const name = arg.split("=")[0];
    if (name === "-h" || name === "--help") {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (name === "--port") opts.port = Number(value());
    else if (name === "--host") opts.host = value();
    else if (name === "--home") opts.home = value();
    else if (name === "--plugins") opts.plugins.push(resolve(value()));
    else if (name === "--token") opts.token = value();
    else throw new Error(`Unknown option ${arg} (see --help).`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error("--port must be 1–65535.");
  return opts;
}

/** The workbench UI build: @oneclient/workbench's dist. */
function workbenchDir(): string {
  const dir = join(dirname(require.resolve("@oneclient/workbench/package.json")), "dist");
  if (!existsSync(join(dir, "index.html"))) throw new Error(`The workbench UI isn't built (${dir}). Run: pnpm --filter @oneclient/workbench run build`);
  return dir;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.home) process.env.ONECLIENT_HOME = resolve(args.home);
  const home = oneclientHome();

  // User-installed plugins, then extra folders, then the bundled ones (packages/plugins next to this package).
  const bundled = resolve(__dirname, "../../plugins");
  const fromEnv = (process.env.ONECLIENT_PLUGINS ?? "").split(delimiter).filter(Boolean).map((p) => resolve(p));
  const pluginDirs = [join(home, "plugins"), ...args.plugins, ...fromEnv, ...(existsSync(bundled) ? [bundled] : [])];

  const { version } = require("../package.json") as { version: string };
  const server = await startServer({ host: args.host, port: args.port, token: loadToken(join(home, "server-token"), args.token), workbenchDir: workbenchDir(), pluginDirs, version });

  console.log(`\noneClient web server ${version} — config in ${server.configDir}`);
  console.log(`  Open: ${server.loginUrl}`);
  if (!["127.0.0.1", "localhost", "::1"].includes(args.host)) {
    console.log(`  ⚠ Listening on ${args.host}: anyone who can reach it and has the token gets your connections and a terminal. Use HTTPS in front.`);
  }
  console.log("  Ctrl+C to stop.\n");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping…");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((err) => {
  if (err instanceof InstanceLockError || err instanceof ConfigVersionError || (err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    console.error(`oneClient: ${(err as Error).message}`);
  } else console.error(err);
  process.exit(1);
});
