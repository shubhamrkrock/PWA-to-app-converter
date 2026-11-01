/** Small shared pieces: links, buttons, loading and error states, status pills. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from './session.tsx';
import { hrefFor, type Route } from './lib/routes.ts';
import { STAGE_LABEL, toneOf } from './lib/status.ts';
import { ApiError } from './lib/api.ts';

export function Link({ to, children, className }: { to: Route; children: ReactNode; className?: string }) {
  const { go } = useApp();
  return (
    <a
      href={hrefFor(to)}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${toneOf(status)}`}>{STAGE_LABEL[status] ?? status}</span>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError || error instanceof Error ? error.message : String(error);
  return (
    <p className="note note-error" role="alert">
      {msg}
    </p>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="muted" aria-busy="true">
      {label}
    </p>
  );
}

/** Loads data with the API; reload() refetches; pollMs keeps it fresh while a condition holds. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], poll?: { ms: number; while: (d: T) => boolean }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, deps);
  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!poll || data === null || !poll.while(data)) return;
    const t = setTimeout(() => void reload(), poll.ms);
    return () => clearTimeout(t);
  }, [data, reload, poll]);
  return { data, error, loading, reload, setData };
}

/** A button that runs an async action, shows it is busy, and reports a failure next to itself. */
export function ActionButton({ onRun, children, kind = 'primary', disabled }: { onRun: () => Promise<unknown>; children: ReactNode; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <span className="action">
      <button
        className={`btn btn-${kind}`}
        disabled={busy || disabled}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await onRun();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Working…' : children}
      </button>
      <ErrorNote error={error} />
    </span>
  );
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
