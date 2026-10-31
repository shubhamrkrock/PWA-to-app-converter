import { useEffect, useRef } from 'react';
import { useApp } from '../session.tsx';
import { ActionButton, ErrorNote, Link, Loading, StatusPill, timeAgo, useLoad } from '../ui.tsx';
import { ARTIFACT_LABEL, formatBytes, isFinished, steps, toneOf } from '../lib/status.ts';
import type { Artifact, Build } from '../types.ts';

const PACKAGES = ['apk', 'aab', 'ipa', 'ios-simulator-app'];

export function BuildPage({ id }: { id: string }) {
  const { api, go } = useApp();
  const build = useLoad(() => api.get<Build>(`/builds/${id}`), [id], { ms: 4000, while: (b) => !isFinished(b.status) });
  const status = build.data?.status;
  const artifacts = useLoad(() => api.get<Artifact[]>(`/builds/${id}/artifacts`), [id, status]);
  const logs = useLoad(() => api.text(`/builds/${id}/logs`), [id], { ms: 4000, while: () => !!status && !isFinished(status) });
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.data]);

  if (build.loading) return <Loading />;
  const b = build.data;
  if (!b) return <ErrorNote error={build.error ?? 'Not found'} />;
  const tone = toneOf(b.status);
  const pkgs = (artifacts.data ?? []).filter((a) => PACKAGES.includes(a.artifact_type));
  const others = (artifacts.data ?? []).filter((a) => !PACKAGES.includes(a.artifact_type));

  const download = async (a: Artifact) => {
    const { url } = await api.post<{ url: string }>(`/artifacts/${a.id}/download-url`);
    location.assign(url);
  };

  return (
    <section className="stack-lg">
      <header className="page-head">
        <div>
          <p className="muted">
            <Link to={{ name: 'project', id: b.project_id, tab: 'builds' }}>← All builds</Link>
          </p>
          <h1>
            {b.platform === 'android' ? 'Android' : 'iPhone'} {b.variant === 'release' ? 'store build' : 'test build'}
          </h1>
          <p className="muted">
            Code {b.commit_sha.slice(0, 7)} · started {timeAgo(b.created_at)}
          </p>
        </div>
        <StatusPill status={b.status} />
      </header>

      <ol className="steps">
        {steps(b.status, b.variant).map((s) => (
          <li key={s.stage} className={`step step-${s.state}`}>
            <span className="dot" aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ol>

      {tone === 'failed' && b.error_message && <p className="note note-error">{b.error_message}</p>}

      <div className="row-actions">
        {!isFinished(b.status) && (
          <ActionButton
            kind="secondary"
            onRun={async () => {
              await api.post(`/builds/${b.id}/cancel`);
              await build.reload();
            }}
          >
            Cancel build
          </ActionButton>
        )}
        {(tone === 'failed' || b.status === 'CANCELLED') && (
          <ActionButton
            onRun={async () => {
              const r = await api.post<{ builds: Array<{ id: string }> }>(`/builds/${b.id}/retry`);
              if (r.builds[0]) go({ name: 'build', id: r.builds[0].id });
            }}
          >
            Try again
          </ActionButton>
        )}
      </div>

      {(pkgs.length > 0 || others.length > 0) && (
        <div className="card">
          <h2>Downloads</h2>
          <ul className="list">
            {[...pkgs, ...others].map((a) => {
              const blocked = PACKAGES.includes(a.artifact_type) && !a.validated;
              return (
                <li key={a.id} className="row">
                  <span className="row-main">
                    <strong>{ARTIFACT_LABEL[a.artifact_type] ?? a.artifact_type}</strong>
                    <span className="muted">
                      {formatBytes(a.file_size)}
                      {blocked ? ' · did not pass its checks' : ''}
                    </span>
                  </span>
                  <ActionButton kind={PACKAGES.includes(a.artifact_type) ? 'primary' : 'secondary'} disabled={blocked} onRun={() => download(a)}>
                    Download
                  </ActionButton>
                </li>
              );
            })}
          </ul>
          <p className="muted">Download links work for 10 minutes. Files are kept for 30 days.</p>
        </div>
      )}

      <details className="card" open={tone === 'failed'}>
        <summary>Build log</summary>
        <pre className="log" ref={logRef}>
          {logs.data || 'The log appears when a build computer picks up the job.'}
        </pre>
      </details>
    </section>
  );
}
