import { type RefObject, useEffect, useRef } from "react";
import type { CompletionProvider } from "@oneclient/plugin-api";
import { type AutocompleteHandle, type AutocompleteOptions, attachAutocomplete } from "./autocomplete.js";

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
