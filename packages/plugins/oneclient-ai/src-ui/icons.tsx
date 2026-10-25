import type { ReactNode } from "react";

/** Small stroke icons (16px grid) so the chat has no icon font or image dependencies. */
const PATHS: Record<string, ReactNode> = {
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.07" />
      <path d="M2.5 2.5v2.8h2.8" />
      <path d="M8 5v3.2l2 1.3" />
    </>
  ),
  plus: <path d="M8 3v10M3 8h10" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r=".8" fill="currentColor" />
      <circle cx="8" cy="8" r=".8" fill="currentColor" />
      <circle cx="12.5" cy="8" r=".8" fill="currentColor" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </>
  ),
  check: <path d="M3 8.5l3.2 3L13 4.5" />,
  trash: (
    <>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
      <path d="M6.8 7v4M9.2 7v4" />
    </>
  ),
  edit: <path d="M3 13h2.6l7-7-2.6-2.6-7 7V13zM9 4.5l2.5 2.5" />,
  download: <path d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2M3 13h10" />,
  send: <path d="M3 8l10-5-3.5 10-2-4.2L3 8zM7.5 8.8L13 3" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />,
  chevron: <path d="M4.5 6.5L8 10l3.5-3.5" />,
  sparkle: <path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3L8 2z" fill="currentColor" stroke="none" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  down: <path d="M8 3v9M4.5 8.5L8 12l3.5-3.5" />,
  tool: <path d="M9.5 3.5a3 3 0 0 0 3 3.9l-6.3 6.3a1.4 1.4 0 0 1-2-2l6.3-6.3a3 3 0 0 0-1-1.9z" />,
  think: (
    <>
      <path d="M5.5 11.5h5M6.5 13.5h3" />
      <path d="M8 2.5a4 4 0 0 0-2.3 7.3c.4.3.6.7.6 1.2h3.4c0-.5.2-.9.6-1.2A4 4 0 0 0 8 2.5z" />
    </>
  ),
};

export function Icon({ name, size = 15 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg className="ai-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** Copies text, with a fallback for frames where the async clipboard API is not allowed. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
