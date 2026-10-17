// REPL driver for oneClient's Electron shell (packages/core).
// Designed for agents: either pipe commands via stdin, or pass a script
// file (one command per line) as argv[2] for a one-shot non-interactive run
// — useful on Windows/CI where there's no tmux to "send-keys" into a REPL.
//
// Usage:
//   node driver.mjs                  # interactive REPL (stdin)
//   node driver.mjs path/to/commands.txt   # batch mode, exits when done
import { _electron as electron } from "playwright-core";
import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.resolve(__dirname, "../../../packages/core");
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(__dirname, "shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const require = createRequire(import.meta.url);

let app = null;
let page = null;

function electronBinary() {
  // `require('electron')` from a plain Node context resolves to the path
  // of the platform's electron executable (Electron's package.json trick).
  return require(path.join(CORE_DIR, "node_modules/electron"));
}

const COMMANDS = {
  async launch() {
    if (app) return console.log("already launched");
    const executablePath = electronBinary();
    app = await electron.launch({
      executablePath,
      args: ["--no-sandbox", CORE_DIR],
      timeout: 30_000,
    });
    await new Promise((r) => setTimeout(r, 2_000));
    page = app.windows().find((w) => !w.url().startsWith("devtools://")) ?? (await app.firstWindow());
    await page.waitForLoadState("domcontentloaded");
    page.on("console", (msg) => console.log(`[console:${msg.type()}]`, msg.text()));
    page.on("pageerror", (err) => console.log("[pageerror]", err.message));
    console.log("launched.", app.windows().length, "window(s):");
    for (const w of app.windows()) console.log(" ", w.url());
  },

  async ss(name) {
    if (!page) return console.log("ERROR: launch first");
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + ".png");
    await page.screenshot({ path: f });
    console.log("screenshot:", f);
  },

  async click(sel) {
    if (!page) return console.log("ERROR: launch first");
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return "NOT_FOUND";
      el.click();
      return "OK";
    }, sel);
    console.log("click", sel, "->", r);
  },

  async "click-text"(text) {
    if (!page) return console.log("ERROR: launch first");
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll("button, a, [role='button'], div, span, td, li")];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return "NOT_FOUND";
      el.click();
      return "OK: " + el.tagName;
    }, text);
    console.log("click-text", JSON.stringify(text), "->", r);
  },

  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 20 });
  },
  // React controlled inputs: setting el.value directly fools React's value
  // tracker into thinking nothing changed, so the subsequent 'input' event
  // doesn't fire onChange. page.fill() avoids that gotcha correctly.
  async fill(args) {
    if (!page) return console.log("ERROR: launch first");
    const [sel, ...rest] = args.split(" ");
    await page.fill(sel, rest.join(" "));
    console.log("fill", sel, "->", rest.join(" "));
  },
  async select(args) {
    if (!page) return console.log("ERROR: launch first");
    const [sel, value] = args.split(" ");
    await page.selectOption(sel, value);
    console.log("select", sel, "->", value);
  },
  async press(key) {
    if (page) await page.keyboard.press(key);
  },
  async wait(ms) {
    await new Promise((r) => setTimeout(r, Number(ms) || 1000));
  },
  async "wait-sel"(sel) {
    if (!page) return console.log("ERROR: launch first");
    try {
      await page.waitForSelector(sel, { timeout: 10_000 });
      console.log("found:", sel);
    } catch {
      console.log("TIMEOUT:", sel);
    }
  },

  async eval(expr) {
    if (!page) return console.log("ERROR: launch first");
    try {
      console.log(JSON.stringify(await page.evaluate(expr)));
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  },

  async text(sel) {
    if (!page) return console.log("ERROR: launch first");
    console.log(await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? "(null)", sel || null));
  },

  async windows() {
    if (!app) return console.log("ERROR: launch first");
    for (const w of app.windows()) console.log(" ", w.url());
  },

  async quit() {
    if (app) await app.close().catch(() => {});
    app = null;
    page = null;
  },
  help() {
    console.log("commands:", Object.keys(COMMANDS).join(", "));
  },
};

async function runLine(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd || cmd.startsWith("#")) return;
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log("unknown:", cmd, "- try: help");
    return;
  }
  try {
    await fn(rest.join(" "));
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

const batchFile = process.argv[2];
if (batchFile) {
  const lines = fs.readFileSync(batchFile, "utf-8").split("\n");
  for (const line of lines) await runLine(line);
  await COMMANDS.quit();
  process.exit(0);
} else {
  const stdin = fs.createReadStream(null, { fd: fs.openSync("/dev/stdin", "r") });
  const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: "driver> " });
  rl.on("line", async (line) => {
    await runLine(line);
    if (line.trim() === "quit") {
      rl.close();
      process.exit(0);
    }
    rl.prompt();
  });
  rl.on("close", async () => {
    await COMMANDS.quit();
    process.exit(0);
  });
  console.log('oneClient driver — "help" for commands, "launch" to start');
  rl.prompt();
}
