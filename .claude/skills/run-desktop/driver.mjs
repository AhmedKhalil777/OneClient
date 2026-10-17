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

// Enumerating a WebContentsView's webContents via app.evaluate occasionally
// comes back empty on the very first call after a view opens (observed
// empirically, cause not fully isolated — looks like a transient race
// inside Electron's webContents registry right after creation). Retrying
// a few times with a short delay is cheap and makes this reliable.
async function evalInView(urlMatch, code, attempts = 6, delayMs = 400) {
  for (let i = 0; i < attempts; i++) {
    const result = await app.evaluate(
      async ({ webContents }, { urlMatch, code }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().includes("/ui/") && w.getURL().includes(urlMatch));
        if (!wc) return { found: false };
        try {
          return { found: true, value: await wc.executeJavaScript(code) };
        } catch (err) {
          return { found: true, error: String(err) };
        }
      },
      { urlMatch, code },
    );
    if (result.found) return result;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { found: false };
}

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
    const proc = app.process();
    proc.stdout?.on("data", (d) => process.stdout.write(`[main stdout] ${d}`));
    proc.stderr?.on("data", (d) => process.stderr.write(`[main stderr] ${d}`));
    await new Promise((r) => setTimeout(r, 2_000));
    page = app.windows().find((w) => !w.url().startsWith("devtools://")) ?? (await app.firstWindow());
    await page.waitForLoadState("domcontentloaded");
    page.on("console", (msg) => console.log(`[console:${msg.type()}]`, msg.text()));
    page.on("pageerror", (err) => console.log("[pageerror]", err.message));
    console.log("launched.", app.windows().length, "window(s):");
    for (const w of app.windows()) console.log(" ", w.url());
  },

  // Uses BrowserWindow.capturePage() in the MAIN process, not page.screenshot(),
  // because Playwright's page.screenshot() only rasterizes the main renderer's
  // own CDP frame — it shows a blank hole wherever a Tier 2 WebContentsView is
  // layered on top. NOTE: BrowserWindow.capturePage() has the same blind spot —
  // it does NOT composite child WebContentsViews either (confirmed empirically;
  // a real user sees them fine via the OS compositor, this is a backing-store
  // limitation of capturePage() specifically). Use `ss-view` to screenshot an
  // open Tier 2 view's own content.
  async ss(name) {
    if (!app) return console.log("ERROR: launch first");
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + ".png");
    const base64 = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const img = await win.capturePage();
      return img.toPNG().toString("base64");
    });
    fs.writeFileSync(f, Buffer.from(base64, "base64"));
    console.log("screenshot:", f);
  },

  // Screenshots a Tier 2 view's own WebContentsView by matching its URL
  // (every view's entry lives under a manifest-declared "ui" dir, so any
  // loaded webContents whose URL contains "/ui/" is one). Pass a substring
  // to disambiguate when more than one view is open.
  //
  // KNOWN LIMITATION: WebContents.capturePage() on a WebContentsView added
  // via contentView.addChildView() has been observed returning a 0x0 image
  // even when the view is fully loaded, responsive, and on-screen with
  // correct bounds (confirmed via img.getSize()). Root cause not isolated —
  // looks like capturePage()'s backing store isn't tracking bounds set via
  // View.setBounds() for child views in this Electron version. A few
  // retries are attempted, but if this keeps failing, use `eval-view`
  // instead (it proves content is alive/interactive without needing a
  // paint) and don't block on getting a pixel screenshot of Tier 2 content.
  async "ss-view"(args) {
    if (!app) return console.log("ERROR: launch first");
    const [urlMatch, name] = args.includes(" ") ? [args.split(" ")[0], args.split(" ").slice(1).join(" ")] : [undefined, args];
    let shot = null;
    for (let i = 0; i < 8 && !shot; i++) {
      shot = await app.evaluate(async ({ webContents }, match) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().includes("/ui/") && w.getURL().includes(match));
        if (!wc) return null;
        const img = await wc.capturePage();
        const b64 = img.toPNG().toString("base64");
        return b64.length > 0 ? b64 : null;
      }, urlMatch ?? "");
      if (!shot) await new Promise((r) => setTimeout(r, 400));
    }
    if (!shot) {
      return console.log(
        "ERROR: no non-empty capture from a matching Tier 2 view for",
        JSON.stringify(urlMatch),
        "- this may be the capturePage() limitation noted above, not a missing view. Try eval-view to confirm the view is actually alive.",
      );
    }
    const f = path.join(SHOT_DIR, (name || `ss-view-${Date.now()}`) + ".png");
    fs.writeFileSync(f, Buffer.from(shot, "base64"));
    console.log("view screenshot:", f);
  },

  // Runs arbitrary JS inside a Tier 2 view's own webContents via Electron's
  // WebContents.executeJavaScript() in the MAIN process — the only way to
  // reach into a WebContentsView's content, since Playwright's `page` only
  // covers the main window and Tier 2 views don't show up in app.windows().
  async "eval-view"(args) {
    if (!app) return console.log("ERROR: launch first");
    const [urlMatch, ...codeParts] = args.split(" ");
    const result = await evalInView(urlMatch, codeParts.join(" "));
    if (!result.found) return console.log("ERROR: no matching Tier 2 view found for", urlMatch);
    if (result.error) return console.log("ERROR:", result.error);
    console.log("eval-view ->", JSON.stringify(result.value));
  },

  // click-text, but inside a Tier 2 view's webContents (see eval-view).
  async "click-text-view"(args) {
    if (!app) return console.log("ERROR: launch first");
    const [urlMatch, ...textParts] = args.split(" ");
    const text = textParts.join(" ");
    const code = `
      (() => {
        const els = [...document.querySelectorAll("button, a, [role='button'], div, span")];
        const el = els.find(e => e.textContent?.trim() === ${JSON.stringify(text)})
                ?? els.find(e => e.textContent?.includes(${JSON.stringify(text)}));
        if (!el) return "NOT_FOUND";
        el.click();
        return "OK: " + el.tagName;
      })()
    `;
    const result = await evalInView(urlMatch, code);
    if (!result.found) return console.log("ERROR: no matching Tier 2 view found for", urlMatch);
    console.log("click-text-view", JSON.stringify(text), "->", result.value);
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
