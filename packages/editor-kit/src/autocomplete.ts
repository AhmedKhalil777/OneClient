import type { CompletionContext, CompletionItem, CompletionProvider } from "@oneclient/plugin-api";
import { caretCoordinates } from "./caret.js";
import { type RankedItem, rankCompletions } from "./rank.js";
import { KIND_BADGE, ensureStyles } from "./styles.js";
import { DEFAULT_WORD_CHAR, applyCompletion, linePrefixAt, wordAt } from "./text.js";

export interface AutocompleteOptions {
  providers: readonly CompletionProvider[];
  /** What counts as part of a word (one character). Default: letters, digits, `_ $ @ #`. */
  wordChar?: RegExp;
  /** Characters typed before the list opens by itself (Ctrl+Space always opens it). Default 1. */
  minPrefixLength?: number;
  /** Delay before asking providers when the list opens from typing. Default 50ms. */
  debounceMs?: number;
  /** Max rows rendered. Default 200. */
  maxItems?: number;
  /** Called after an item is inserted. */
  onAccept?: (item: CompletionItem) => void;
}

export interface AutocompleteHandle {
  /** Open the list at the caret, as Ctrl+Space does. */
  trigger(): void;
  close(): void;
  isOpen(): boolean;
  setProviders(providers: readonly CompletionProvider[]): void;
  /** Remove all listeners and the popup. */
  dispose(): void;
}

interface Session {
  wordStart: number;
  explicit: boolean;
  triggerCharacter: string | undefined;
  items: CompletionItem[];
  ranked: RankedItem[];
  selected: number;
}

/**
 * Adds VS Code-style autocomplete to a plain <textarea>:
 * opens while typing a word (or on a provider's trigger character, or
 * Ctrl+Space), fuzzy-filters as you keep typing, ↑/↓/PgUp/PgDn to move,
 * Enter/Tab to accept, Esc to close. Accepting goes through
 * `execCommand("insertText")`, so it's one step on the native undo stack
 * and frameworks (React's onChange) see a normal input event.
 */
export function attachAutocomplete(textarea: HTMLTextAreaElement, options: AutocompleteOptions): AutocompleteHandle {
  ensureStyles();
  let providers = options.providers;
  const wordChar = options.wordChar ?? DEFAULT_WORD_CHAR;
  const minPrefix = options.minPrefixLength ?? 1;
  const debounceMs = options.debounceMs ?? 50;
  const maxItems = options.maxItems ?? 200;

  let session: Session | null = null;
  let requestId = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let applying = false;

  const popup = document.createElement("div");
  popup.className = "oc-ac";
  popup.hidden = true;
  popup.setAttribute("role", "listbox");
  const list = document.createElement("div");
  list.className = "oc-ac-list";
  const doc = document.createElement("div");
  doc.className = "oc-ac-doc";
  popup.append(list, doc);
  document.body.appendChild(popup);
  // Keep focus in the textarea when clicking the list.
  popup.addEventListener("mousedown", (e) => e.preventDefault());

  const triggerChars = () => new Set(providers.flatMap((p) => p.triggerCharacters ?? []));

  function start(explicit: boolean, triggerCharacter?: string) {
    const offset = textarea.selectionStart;
    const text = textarea.value;
    const { start: wordStart, prefix } = wordAt(text, offset, wordChar);
    const context: CompletionContext = {
      text,
      offset,
      prefix,
      wordStart,
      linePrefix: linePrefixAt(text, offset),
      triggerCharacter,
      explicit,
    };
    // A trigger character only asks the providers that declared it.
    const asked = triggerCharacter ? providers.filter((p) => p.triggerCharacters?.includes(triggerCharacter)) : providers;
    const id = ++requestId;
    void Promise.allSettled(asked.map((p) => Promise.resolve(p.provideCompletions(context)))).then((results) => {
      if (id !== requestId) return; // superseded
      const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      for (const r of results) if (r.status === "rejected") console.warn("[autocomplete] provider failed:", r.reason);
      session = { wordStart, explicit, triggerCharacter, items, ranked: [], selected: 0 };
      refilter();
    });
  }

  function refilter() {
    if (!session) return;
    const offset = textarea.selectionStart;
    if (offset < session.wordStart) return close();
    const prefix = textarea.value.slice(session.wordStart, offset);
    if ([...prefix].some((ch) => !wordChar.test(ch))) return close();
    session.ranked = rankCompletions(session.items, prefix, maxItems);
    // Nothing left, or the only match is exactly what's typed: nothing to offer.
    const only = session.ranked.length === 1 ? session.ranked[0]!.item : null;
    if (session.ranked.length === 0 || (only && !session.explicit && (only.insertText ?? only.label) === prefix)) {
      return hide();
    }
    session.selected = 0;
    render();
  }

  function render() {
    if (!session) return;
    list.replaceChildren(
      ...session.ranked.map((r, i) => {
        const row = document.createElement("div");
        row.className = `oc-ac-item${i === session!.selected ? " selected" : ""}`;
        row.setAttribute("role", "option");
        const badge = KIND_BADGE[r.item.kind ?? "text"] ?? KIND_BADGE.text!;
        const kind = document.createElement("span");
        kind.className = "oc-ac-kind";
        kind.textContent = badge.letter;
        kind.style.background = badge.color;
        kind.title = r.item.kind ?? "text";
        const label = document.createElement("span");
        label.className = "oc-ac-label";
        appendHighlighted(label, r.item.label, r.match.positions);
        row.append(kind, label);
        if (r.item.detail) {
          const detail = document.createElement("span");
          detail.className = "oc-ac-detail";
          detail.textContent = r.item.detail;
          row.append(detail);
        }
        row.addEventListener("mousemove", () => select(i));
        row.addEventListener("click", () => accept(i));
        return row;
      }),
    );
    updateDoc();
    popup.hidden = false;
    position();
    scrollSelectedIntoView();
  }

  function select(index: number) {
    if (!session || index === session.selected) return;
    list.children[session.selected]?.classList.remove("selected");
    session.selected = index;
    list.children[index]?.classList.add("selected");
    updateDoc();
    scrollSelectedIntoView();
  }

  function updateDoc() {
    const item = session?.ranked[session.selected]?.item;
    doc.textContent = item?.documentation ?? "";
    doc.hidden = !item?.documentation;
  }

  function scrollSelectedIntoView() {
    (list.children[session?.selected ?? 0] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  function position() {
    if (!session) return;
    const caret = caretCoordinates(textarea, session.wordStart);
    const box = textarea.getBoundingClientRect();
    // Caret scrolled out of the textarea: hide rather than float over something else.
    if (caret.top < box.top - 2 || caret.top > box.bottom) return void (popup.hidden = true);
    popup.hidden = false;
    const { width, height } = popup.getBoundingClientRect();
    const below = caret.top + caret.height + 2;
    const top = below + height > window.innerHeight && caret.top - height - 2 > 0 ? caret.top - height - 2 : below;
    const left = Math.max(4, Math.min(caret.left - 24, window.innerWidth - width - 4));
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }

  function accept(index = session?.selected ?? 0) {
    const ranked = session?.ranked[index];
    if (!session || !ranked) return;
    const { wordStart } = session;
    const offset = textarea.selectionStart;
    const { insert, caret } = applyCompletion(textarea.value, wordStart, offset, ranked.item.insertText ?? ranked.item.label);
    close();
    applying = true;
    try {
      textarea.focus();
      textarea.setSelectionRange(wordStart, offset);
      if (!document.execCommand("insertText", false, insert)) {
        // Fallback (no execCommand): set through the prototype setter so React's value tracker sees a change.
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(textarea, textarea.value.slice(0, wordStart) + insert + textarea.value.slice(offset));
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      textarea.setSelectionRange(caret, caret);
    } finally {
      applying = false;
    }
    options.onAccept?.(ranked.item);
  }

  function hide() {
    popup.hidden = true;
  }

  function close() {
    requestId++; // drop in-flight requests
    clearTimeout(debounce);
    session = null;
    popup.hidden = true;
    list.replaceChildren();
  }

  const isOpen = () => session !== null && !popup.hidden;

  // ---- event wiring ----

  function onInput(e: Event) {
    if (applying) return;
    const inputType = (e as InputEvent).inputType ?? "";
    const offset = textarea.selectionStart;
    const ch = textarea.value[offset - 1];

    if (inputType.startsWith("insert") && ch && triggerChars().has(ch)) {
      clearTimeout(debounce);
      return start(false, ch);
    }
    if (inputType.startsWith("insert") && ch && wordChar.test(ch)) {
      const { start: wordStart, prefix } = wordAt(textarea.value, offset, wordChar);
      if (session && session.wordStart === wordStart) return refilter();
      if (prefix.length >= minPrefix) {
        clearTimeout(debounce);
        debounce = setTimeout(() => start(false), debounceMs);
      }
      return;
    }
    if (inputType.startsWith("delete") && session) {
      const { start: wordStart, prefix } = wordAt(textarea.value, offset, wordChar);
      if (wordStart !== session.wordStart || (!prefix && !session.explicit && !session.triggerCharacter)) return close();
      return refilter();
    }
    close();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey && (e.key === " " || e.code === "Space")) {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(debounce);
      return start(true);
    }
    if (!isOpen() || !session) return;
    const count = session.ranked.length;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation(); // keep the host editor's own Tab/Enter/Esc handling out of it
    };
    switch (e.key) {
      case "ArrowDown":
        handled();
        return select((session.selected + 1) % count);
      case "ArrowUp":
        handled();
        return select((session.selected - 1 + count) % count);
      case "PageDown":
        handled();
        return select(Math.min(count - 1, session.selected + 8));
      case "PageUp":
        handled();
        return select(Math.max(0, session.selected - 8));
      case "Enter":
      case "Tab":
        if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
        handled();
        return accept();
      case "Escape":
        handled();
        return close();
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        // Let the caret move, then re-check whether it's still inside the word.
        queueMicrotask(checkCaret);
        return;
    }
  }

  function checkCaret() {
    if (!session) return;
    const offset = textarea.selectionStart;
    if (textarea.selectionEnd !== offset || offset < session.wordStart || wordAt(textarea.value, offset, wordChar).start !== session.wordStart) {
      close();
    } else {
      refilter();
    }
  }

  const onBlur = () => close();
  const onScroll = () => {
    if (isOpen()) position();
  };
  const onMouseUp = () => {
    if (session) checkCaret();
  };
  const onResize = () => close();

  // Capture phase: runs before framework handlers bubbling up from the textarea.
  textarea.addEventListener("keydown", onKeyDown, true);
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("blur", onBlur);
  textarea.addEventListener("scroll", onScroll);
  textarea.addEventListener("mouseup", onMouseUp);
  window.addEventListener("resize", onResize);

  return {
    trigger: () => start(true),
    close,
    isOpen,
    setProviders(next) {
      providers = next;
    },
    dispose() {
      close();
      textarea.removeEventListener("keydown", onKeyDown, true);
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("blur", onBlur);
      textarea.removeEventListener("scroll", onScroll);
      textarea.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("resize", onResize);
      popup.remove();
    },
  };
}

function appendHighlighted(target: HTMLElement, text: string, positions: number[]) {
  if (positions.length === 0) {
    target.textContent = text;
    return;
  }
  const marks = new Set(positions);
  let run = "";
  let runMarked = false;
  const flush = () => {
    if (!run) return;
    if (runMarked) {
      const b = document.createElement("b");
      b.textContent = run;
      target.append(b);
    } else {
      target.append(run);
    }
    run = "";
  };
  [...text].forEach((ch, i) => {
    const marked = marks.has(i);
    if (marked !== runMarked) {
      flush();
      runMarked = marked;
    }
    run += ch;
  });
  flush();
}
