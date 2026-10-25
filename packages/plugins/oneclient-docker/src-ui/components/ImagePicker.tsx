import { useEffect, useRef, useState } from "react";
import { Icon } from "@oneclient/editor-kit/react";
import { type ImageSearch, type ImageTags, imageTags, searchImages } from "../api.js";

/** `nginx:alpine` → `nginx`; keeps registry ports (`localhost:5000/app` → `localhost:5000/app`). */
const repoOf = (ref: string) => ref.replace(/:[^/:]*$/, "");
const tagOf = (ref: string) => /:([^/:]*)$/.exec(ref)?.[1] ?? "";

/** The owning plugin's icon when one recognises the image (postgres → PostgreSQL), else the Docker image icon. */
function ImageIcon({ icon }: { icon: string }) {
  return <Icon id={icon.startsWith("$(") ? icon.slice(2, -1) : "docker-image"} size={18} />;
}

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Pick an image like a package: type to search what is already on this engine and what Docker Hub offers, pick one,
 * then pick a tag from the registry. Typing a full reference (`ghcr.io/org/app:1`) works too.
 */
export function ImagePicker({ value, onChange, disabled, placeholder }: { value: string; onChange: (ref: string) => void; disabled?: boolean; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<ImageSearch | null>(null);
  const [tags, setTags] = useState<ImageTags | null>(null);
  const [searching, setSearching] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const picked = useRef(false);

  const repo = repoOf(value);

  // Search while typing (not right after a pick, which sets the field itself).
  useEffect(() => {
    if (picked.current) {
      picked.current = false;
      return;
    }
    if (!open) return;
    setSearching(true);
    const t = setTimeout(() => {
      searchImages(repo)
        .then(setResults)
        .catch((e: unknown) => setResults({ local: [], hub: [], error: e instanceof Error ? e.message : String(e) }))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [repo, open]);

  // Tags for the chosen repository.
  useEffect(() => {
    setTags(null);
    if (!repo.trim() || disabled) return;
    const t = setTimeout(() => {
      imageTags(repo)
        .then(setTags)
        .catch(() => setTags({ tags: [] }));
    }, 500);
    return () => clearTimeout(t);
  }, [repo, disabled]);

  useEffect(() => {
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);

  function pick(ref: string) {
    picked.current = true;
    onChange(ref);
    setOpen(false);
  }

  return (
    <div className="image-picker" ref={box}>
      <div className="image-picker-row">
        <input value={value} disabled={disabled} placeholder={placeholder ?? "Search images, e.g. postgres"} spellCheck={false} onFocus={() => setOpen(true)} onChange={(e) => (setOpen(true), onChange(e.target.value))} />
        {tags && tags.tags.length > 0 && (
          <select
            value={tagOf(value)}
            disabled={disabled}
            title="Tag"
            onChange={(e) => pick(e.target.value ? `${repo}:${e.target.value}` : repo)}
          >
            <option value="">{tagOf(value) ? "(no tag)" : "tag…"}</option>
            {tagOf(value) && !tags.tags.some((t) => t.name === tagOf(value)) && <option value={tagOf(value)}>{tagOf(value)}</option>}
            {tags.tags.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
                {t.size ? ` · ${formatSize(t.size)}` : ""}
              </option>
            ))}
          </select>
        )}
      </div>
      {tags?.note || tags?.error ? <div className="dim image-picker-note">{tags.error ?? tags.note}</div> : null}
      {open && (
        <div className="image-picker-list">
          {searching && !results && <div className="image-picker-item dim">Searching…</div>}
          {results && results.local.length > 0 && <div className="image-picker-head">On this engine</div>}
          {results?.local.slice(0, 8).map((l) => (
            <div key={l.name} className="image-picker-item" onMouseDown={(e) => (e.preventDefault(), pick(l.name))}>
              <ImageIcon icon={l.icon} />
              <span className="image-picker-text">{l.name}</span>
            </div>
          ))}
          {results && results.hub.length > 0 && <div className="image-picker-head">Docker Hub{searching ? " …" : ""}</div>}
          {results?.hub.map((h) => (
            <div key={h.name} className="image-picker-item" onMouseDown={(e) => (e.preventDefault(), pick(h.name))}>
              <ImageIcon icon={h.icon} />
              <span className="image-picker-text">
                <span>
                  {h.name} {h.official && <span className="badge badge-running">official</span>}
                </span>
                <span className="dim">
                  ★ {h.stars}
                  {h.description ? ` — ${h.description.slice(0, 70)}` : ""}
                </span>
              </span>
            </div>
          ))}
          {results?.error && <div className="image-picker-item dim">Docker Hub search unavailable: {results.error}</div>}
          {results && !results.error && results.local.length === 0 && results.hub.length === 0 && !searching && (
            <div className="image-picker-item dim">{repo.trim().length < 2 ? "Type at least 2 characters to search Docker Hub." : "No matches."}</div>
          )}
        </div>
      )}
    </div>
  );
}
