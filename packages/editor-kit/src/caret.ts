/**
 * Viewport coordinates of a character offset inside a <textarea>.
 *
 * Textareas don't expose caret geometry, so this lays the same text out in
 * an invisible <div> with identical box/typography styles and measures a
 * marker <span> at the offset, then adjusts for the textarea's scroll.
 */
const MIRRORED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "textIndent",
  "textTransform",
  "whiteSpace",
  "wordWrap",
  "overflowWrap",
] as const;

let mirror: HTMLDivElement | null = null;

export function caretCoordinates(textarea: HTMLTextAreaElement, offset: number): { left: number; top: number; height: number } {
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    document.body.appendChild(mirror);
  }
  const style = getComputedStyle(textarea);
  const m = mirror.style;
  for (const prop of MIRRORED) m[prop] = style[prop];
  m.position = "absolute";
  m.visibility = "hidden";
  m.top = "0";
  m.left = "-9999px";
  m.overflow = "hidden";
  m.height = "auto";
  // A textarea with wrap="off" behaves like white-space: pre.
  if (textarea.getAttribute("wrap") === "off") m.whiteSpace = "pre";

  mirror.textContent = textarea.value.slice(0, offset);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(offset, offset + 1) || ".";
  mirror.appendChild(marker);

  const rect = textarea.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  return {
    left: rect.left + marker.offsetLeft - textarea.scrollLeft,
    top: rect.top + marker.offsetTop - textarea.scrollTop,
    height: lineHeight,
  };
}
