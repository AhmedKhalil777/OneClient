import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NotificationAction, NotificationInfo } from "@oneclient/backend/shared/notifications.js";

const MAX_TOASTS = 4;
const DND_KEY = "oneclient.notifications.dnd";
const SEVERITY_ICON: Record<NotificationInfo["severity"], string> = { info: "ℹ", success: "✓", warning: "⚠", error: "✗" };
const hideAfterMs = (n: NotificationInfo) => (n.sticky ? 0 : n.severity === "warning" ? 10_000 : 6_000);

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

function Item({ n, onAction, onClose, closeTitle, toast }: { n: NotificationInfo; onAction: (a: NotificationAction) => void; onClose: () => void; closeTitle: string; toast?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`notif notif-${n.severity}${toast ? " notif-toast" : ""}`} role={n.severity === "error" ? "alert" : "status"}>
      <span className="notif-icon">{SEVERITY_ICON[n.severity]}</span>
      <div className="notif-body">
        <div className="notif-message">{n.message}</div>
        <div className="notif-meta">
          {n.source} · {ago(n.createdAt)}
          {n.detail && (
            <>
              {" · "}
              <button className="notif-link" onClick={() => setOpen(!open)}>
                {open ? "Hide details" : "Details"}
              </button>
            </>
          )}
        </div>
        {open && n.detail && <pre className="notif-detail">{n.detail}</pre>}
        {n.actions.length > 0 && (
          <div className="notif-actions">
            {n.actions.map((a, i) => (
              <button key={i} className="notif-btn" onClick={() => onAction(a)}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="notif-close" title={closeTitle} onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

/**
 * Toasts (bottom right) for new notifications and the status bar bell that opens the Notification Center — like VS
 * Code's. A toast fades after a few seconds unless it is an error (or asked to stay); closing it only hides the toast,
 * the Center keeps the notification until it is dismissed there.
 */
export function NotificationBell({ onAction }: { onAction: (action: NotificationAction) => void }) {
  const [items, setItems] = useState<NotificationInfo[]>([]);
  const [toastIds, setToastIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = useState(() => Date.now());
  const [dnd, setDnd] = useState(() => {
    try {
      return localStorage.getItem(DND_KEY) === "1";
    } catch {
      return false;
    }
  });
  const dndRef = useRef(dnd);
  dndRef.current = dnd;
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const box = useRef<HTMLDivElement>(null);

  const hideToast = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToastIds((ids) => ids.filter((x) => x !== id));
  }, []);

  const armTimer = useCallback(
    (n: NotificationInfo) => {
      const ms = hideAfterMs(n);
      const old = timers.current.get(n.id);
      if (old) clearTimeout(old);
      if (ms > 0) timers.current.set(n.id, setTimeout(() => hideToast(n.id), ms));
    },
    [hideToast],
  );

  useEffect(() => {
    let alive = true;
    void window.oneclient.listNotifications().then((list) => alive && setItems(list));
    const offAdded = window.oneclient.onNotificationAdded((n) => {
      setItems((prev) => [...prev.filter((x) => x.id !== n.id), n]);
      if (n.silent || dndRef.current) return;
      setToastIds((ids) => [...ids.filter((x) => x !== n.id), n.id]);
      armTimer(n);
    });
    const offDismissed = window.oneclient.onNotificationDismissed((id) => {
      setItems((prev) => prev.filter((x) => x.id !== id));
      hideToast(id);
    });
    const offCleared = window.oneclient.onNotificationsCleared(() => {
      setItems([]);
      setToastIds([]);
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    });
    const pending = timers.current;
    return () => {
      alive = false;
      offAdded();
      offDismissed();
      offCleared();
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, [armTimer, hideToast]);

  // Click outside / Escape closes the Center.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toasts = useMemo(() => toastIds.map((id) => items.find((n) => n.id === id)).filter((n): n is NotificationInfo => !!n).slice(-MAX_TOASTS), [toastIds, items]);
  const unread = items.filter((n) => n.createdAt > seenAt).length;
  const act = (a: NotificationAction, id: string) => {
    hideToast(id);
    onAction(a);
  };

  return (
    <>
      <button
        className={`status-button ${open ? "active" : ""}`}
        title={dnd ? "Notifications (Do Not Disturb)" : "Notifications"}
        onClick={() => {
          setOpen(!open);
          setSeenAt(Date.now());
          setToastIds([]);
        }}
      >
        {dnd ? "🔕" : "🔔"}
        {unread > 0 && <span className="notif-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {toasts.length > 0 && !open && (
        <div className="notif-toasts">
          {toasts.map((n) => (
            <div key={n.id} onMouseEnter={() => timers.current.get(n.id) && (clearTimeout(timers.current.get(n.id)), timers.current.delete(n.id))} onMouseLeave={() => armTimer(n)}>
              <Item n={n} toast onAction={(a) => act(a, n.id)} onClose={() => hideToast(n.id)} closeTitle="Hide (stays in the Notification Center)" />
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="notif-center" ref={box}>
          <div className="notif-center-head">
            <strong>Notifications</strong>
            <span className="notif-grow" />
            <button
              className="notif-link"
              title="Stop toasts from appearing; notifications still collect here"
              onClick={() => {
                const next = !dnd;
                setDnd(next);
                try {
                  localStorage.setItem(DND_KEY, next ? "1" : "0");
                } catch {
                  /* not persisted */
                }
              }}
            >
              {dnd ? "🔕 Do Not Disturb: on" : "🔔 Do Not Disturb: off"}
            </button>
            <button className="notif-link" disabled={items.length === 0} onClick={() => void window.oneclient.clearNotifications()}>
              Clear all
            </button>
          </div>
          <div className="notif-center-list">
            {items.length === 0 && <div className="notif-empty">No new notifications</div>}
            {[...items].reverse().map((n) => (
              <Item key={n.id} n={n} onAction={(a) => (setOpen(false), act(a, n.id))} onClose={() => void window.oneclient.dismissNotification(n.id)} closeTitle="Dismiss" />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
