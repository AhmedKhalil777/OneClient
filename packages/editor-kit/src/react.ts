import { type RefObject, createElement, useEffect, useRef, useState } from "react";
import type { CompletionProvider, ThemeState } from "@oneclient/plugin-api";
import { type AutocompleteHandle, type AutocompleteOptions, attachAutocomplete } from "./autocomplete.js";
import { getTheme, iconUrl, onThemeChange } from "./theme.js";

/** The active theme; re-renders on theme switches. */
export function useTheme(): ThemeState | null {
  const [theme, setTheme] = useState<ThemeState | null>(() => getTheme());
  useEffect(() => onThemeChange(setTheme), []);
  return theme;
}

/**
 * An icon from oneClient's icon registry — the same ids plugins use as
 * `$(id)` (built-in: folder, file, database, table, terminal, play, refresh, …,
 * plus any `contributes.icons`). Monochrome icons take the current text
 * color (CSS mask), so they follow the theme; `colored` icons draw as-is.
 */
export function Icon({ id, size = 16, title, className }: { id: string; size?: number; title?: string; className?: string }) {
  const theme = useTheme();
  const url = iconUrl(id, theme);
  if (theme?.icons[id]?.colored) {
    return createElement("img", { src: url, width: size, height: size, alt: "", title, className });
  }
  return createElement("span", {
    role: "img",
    "aria-label": title ?? id,
    title,
    className: `oc-icon ${className ?? ""}`,
    style: { width: size, height: size, WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` },
  });
}

/**
 * React binding for `attachAutocomplete`. Follows whatever element `ref`
 * points at after each render — so a textarea that only appears later
 * (after a loading state) or gets remounted is picked up — and keeps the
 * providers current without re-attaching, so an open list survives re-renders.
 *
 *   const ref = useRef<HTMLTextAreaElement>(null);
 *   useAutocomplete(ref, { providers: [mySqlProvider, wordsProvider()] });
 */
export function useAutocomplete(
  ref: RefObject<HTMLTextAreaElement | null>,
  options: AutocompleteOptions,
): RefObject<AutocompleteHandle | null> {
  const handle = useRef<AutocompleteHandle | null>(null);
  const attachedTo = useRef<HTMLTextAreaElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // No deps on purpose: cheap identity check after every render.
  useEffect(() => {
    const el = ref.current;
    if (el === attachedTo.current) return;
    handle.current?.dispose();
    handle.current = null;
    attachedTo.current = el;
    if (el) {
      handle.current = attachAutocomplete(el, {
        ...optionsRef.current,
        onAccept: (item) => optionsRef.current.onAccept?.(item),
      });
    }
  });

  useEffect(() => {
    handle.current?.setProviders(options.providers as readonly CompletionProvider[]);
  }, [options.providers]);

  useEffect(
    () => () => {
      handle.current?.dispose();
      handle.current = null;
      attachedTo.current = null;
    },
    [],
  );

  return handle;
}
