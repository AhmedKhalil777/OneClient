interface Listing {
  path: string;
  parent: string | null;
  dirs: Array<{ name: string; path: string }>;
  files?: Array<{ name: string; path: string }>;
  roots: string[];
  home: string;
}

/**
 * "Open Folder…" in the browser: browses folders on the server machine (where the Explorer, Git and the terminal
 * work), since a browser can't hand a real path over. Resolves to the chosen absolute path, or null.
 */
export function pickFolder(list: (path?: string) => Promise<Listing>, defaultPath?: string, options: { files?: boolean } = {}): Promise<string | null> {
  const files = options.files === true;
  const what = files ? "Choose File" : "Open Folder";
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "folder-picker-overlay";
    overlay.innerHTML = `
      <div class="folder-picker" role="dialog" aria-modal="true" aria-label="${what}">
        <div class="folder-picker-title">${what} <span class="folder-picker-hint">on the server</span></div>
        <div class="folder-picker-bar">
          <select class="folder-picker-roots" title="Drive"></select>
          <input class="folder-picker-path" spellcheck="false" />
        </div>
        <div class="folder-picker-list" tabindex="0"></div>
        <div class="folder-picker-error"></div>
        <div class="folder-picker-actions">
          <button type="button" class="folder-picker-cancel">Cancel</button>
          <button type="button" class="folder-picker-open primary">${files ? "Choose" : "Open"}</button>
        </div>
      </div>`;
    const $ = <T extends HTMLElement>(sel: string) => overlay.querySelector<T>(sel)!;
    const pathInput = $<HTMLInputElement>(".folder-picker-path");
    const listEl = $<HTMLDivElement>(".folder-picker-list");
    const roots = $<HTMLSelectElement>(".folder-picker-roots");
    const errorEl = $<HTMLDivElement>(".folder-picker-error");
    let current = "";
    let chosen = "";

    const done = (value: string | null) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const go = async (path?: string) => {
      try {
        const listing = await list(path);
        current = listing.path;
        pathInput.value = listing.path;
        errorEl.textContent = "";
        roots.innerHTML = listing.roots.map((r) => `<option>${escape(r)}</option>`).join("");
        roots.value = listing.roots.find((r) => listing.path.toLowerCase().startsWith(r.toLowerCase())) ?? listing.roots[0] ?? "";
        roots.hidden = listing.roots.length <= 1;
        listEl.innerHTML = "";
        const rows = listing.parent ? [{ name: "..", path: listing.parent }, ...listing.dirs] : listing.dirs;
        for (const d of rows) {
          const row = document.createElement("div");
          row.className = "folder-picker-row";
          row.textContent = d.name === ".." ? "⬑ .." : `📁 ${d.name}`;
          row.title = d.path;
          row.addEventListener("click", () => void go(d.path));
          listEl.appendChild(row);
        }
        // Files: a click selects (and fills the path box), a double-click chooses.
        for (const f of files ? (listing.files ?? []) : []) {
          const row = document.createElement("div");
          row.className = "folder-picker-row";
          row.textContent = `📄 ${f.name}`;
          row.title = f.path;
          row.addEventListener("click", () => {
            chosen = f.path;
            pathInput.value = f.path;
            listEl.querySelectorAll(".folder-picker-row.selected").forEach((r) => r.classList.remove("selected"));
            row.classList.add("selected");
          });
          row.addEventListener("dblclick", () => done(f.path));
          listEl.appendChild(row);
        }
        if (rows.length === 0 && !(files && listing.files?.length)) listEl.innerHTML = `<div class="folder-picker-empty">${files ? "Nothing here" : "No sub-folders"}</div>`;
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message.replace(/^.*?: /, "") : String(err);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      } else if (e.key === "Enter" && document.activeElement === pathInput) {
        e.preventDefault();
        void go(pathInput.value);
      }
    };

    $(".folder-picker-cancel").addEventListener("click", () => done(null));
    $(".folder-picker-open").addEventListener("click", () => done(files ? chosen || pathInput.value.trim() || null : pathInput.value.trim() || current || null));
    roots.addEventListener("change", () => void go(roots.value));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) done(null);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    void go(defaultPath).then(() => pathInput.focus());
  });
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
