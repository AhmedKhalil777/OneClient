/**
 * The web app replaces the browser's right-click menu with oneClient's own. Whoever receives a `contextmenu` event
 * that nothing handled (the shell, or a view's iframe) describes it with this and fires APP_CONTEXT_MENU_EVENT on
 * the shell's window; the shell shows its menu.
 *
 * Holding Shift while right-clicking still opens the browser's menu (Inspect, Save image…), as in VS Code for the web.
 */
export const APP_CONTEXT_MENU_EVENT = "oneclient:context-menu";

export interface AppContextMenuRequest {
  /** Viewport coordinates in the shell's window. */
  x: number;
  y: number;
  /** The view the click happened in, if any (its iframe is what Cut / Copy / Paste act on). */
  instanceId?: string;
  /** Selected text at the click. */
  selection: string;
  /** The click was on a text field or editable area. */
  editable: boolean;
  /** An http(s) link under the pointer. */
  link?: string;
  /** In the shell itself: the element to hand focus back to before an edit command runs. */
  target?: HTMLElement;
  /** The panels the click is in, innermost first (see `data-ctx` below). */
  areas: ContextArea[];
}

/**
 * Parts of the shell mark themselves with `data-ctx="name"`; extra `data-ctx-<key>="value"` attributes carry details
 * (a task row has `data-ctx-id`), and `data-ctx-copy` makes the element's text available for a "Copy" item.
 */
export interface ContextArea {
  name: string;
  data: Record<string, string>;
  text: string;
}

const MAX_AREA_TEXT = 200_000;

/** The marked ancestors of `start` (itself included), innermost first. */
export function collectAreas(start: Element | null): ContextArea[] {
  const areas: ContextArea[] = [];
  for (let el = start?.closest("[data-ctx]") ?? null; el; el = el.parentElement?.closest("[data-ctx]") ?? null) {
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries((el as HTMLElement).dataset)) {
      if (key.startsWith("ctx") && key !== "ctx" && key !== "ctxCopy" && value !== undefined) data[key.charAt(3).toLowerCase() + key.slice(4)] = value;
    }
    areas.push({ name: (el as HTMLElement).dataset.ctx ?? "", data, text: (el as HTMLElement).dataset.ctxCopy !== undefined ? ((el as HTMLElement).innerText ?? "").slice(0, MAX_AREA_TEXT) : "" });
  }
  return areas;
}

const EDITABLE = "input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, [contenteditable=''], [contenteditable='true']";

/** Describes a `contextmenu` event that happened in `win`; `origin` is where that window sits in the shell's window. */
export function describeContextMenu(e: MouseEvent, win: Window, origin: { x: number; y: number }, instanceId?: string, frame?: Element): AppContextMenuRequest {
  // Duck-typed: an element from a view's iframe is not an instance of this window's HTMLElement.
  const maybe = e.target as HTMLElement | null;
  const target = maybe && typeof maybe.closest === "function" ? maybe : null;
  const link = target?.closest("a[href]")?.getAttribute("href") ?? undefined;
  let absolute: string | undefined;
  try {
    const url = link ? new URL(link, win.location.href) : undefined;
    if (url && (url.protocol === "http:" || url.protocol === "https:")) absolute = url.toString();
  } catch {
    /* not a usable link */
  }
  const field = target?.closest(EDITABLE) as HTMLInputElement | HTMLTextAreaElement | null;
  let selection = win.getSelection()?.toString() ?? "";
  if (!selection && field && "selectionStart" in field && field.selectionStart !== null && field.selectionEnd !== null) {
    selection = field.value.slice(field.selectionStart, field.selectionEnd);
  }
  return {
    x: origin.x + e.clientX,
    y: origin.y + e.clientY,
    ...(instanceId ? { instanceId } : {}),
    selection,
    editable: Boolean(field),
    ...(absolute ? { link: absolute } : {}),
    ...(field && !instanceId ? { target: field } : {}),
    // A click inside a view's iframe belongs to the panel the iframe sits in.
    areas: collectAreas(frame ?? target),
  };
}

/** Takes over a right click nobody handled. Returns false when the browser's own menu should show (Shift held). */
export function takeOverContextMenu(e: MouseEvent, win: Window, origin: { x: number; y: number }, instanceId?: string, frame?: Element): boolean {
  if (e.defaultPrevented || e.shiftKey) return false;
  e.preventDefault();
  window.dispatchEvent(new CustomEvent<AppContextMenuRequest>(APP_CONTEXT_MENU_EVENT, { detail: describeContextMenu(e, win, origin, instanceId, frame) }));
  return true;
}
