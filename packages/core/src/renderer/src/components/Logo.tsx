import { useId } from "react";

/**
 * The oneClient mark, inline (the renderer's CSP doesn't allow data: images).
 * Keep in sync with packages/core/resources/logo.svg — the source the app
 * icons are rendered from (`pnpm --filter @oneclient/core run icons`).
 */
export function Logo({ size = 24, title = "oneClient" }: { size?: number; title?: string }) {
  // Gradient ids must be unique per instance or two logos on a page share/break fills.
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 256 256" width={size} height={size} role="img" aria-label={title}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1f8fff" />
          <stop offset="1" stopColor="#6b4dff" />
        </linearGradient>
        <linearGradient id={`${id}-ring`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.18" />
        </linearGradient>
      </defs>
      <rect x="12" y="12" width="232" height="232" rx="58" fill={`url(#${id}-bg)`} />
      <circle cx="128" cy="132" r="78" fill="none" stroke={`url(#${id}-ring)`} strokeWidth="9" />
      <path
        d="M128 132 L195.5 93 M128 132 L60.5 93 M128 132 L128 210"
        stroke="#ffffff"
        strokeOpacity="0.22"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path d="M106 92 L138 70 V182" fill="none" stroke="#ffffff" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M110 186 H166" stroke="#ffffff" strokeWidth="22" strokeLinecap="round" />
      <circle cx="195.5" cy="93" r="15" fill="#ffd166" stroke="#ffffff" strokeWidth="5" />
      <circle cx="60.5" cy="93" r="15" fill="#06d6a0" stroke="#ffffff" strokeWidth="5" />
      <circle cx="128" cy="210" r="15" fill="#ff6b9a" stroke="#ffffff" strokeWidth="5" />
    </svg>
  );
}
