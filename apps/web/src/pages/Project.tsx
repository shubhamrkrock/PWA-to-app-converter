import { useState } from 'react';
import { useApp } from '../session.tsx';
import { ActionButton, ErrorNote, Link, Loading, StatusPill, timeAgo, useLoad } from '../ui.tsx';
import type { AnalysisJob, AnalysisRow, Build, Credential, Project as ProjectRow, SavedConfig } from '../types.ts';
import type { ProjectTab } from '../lib/routes.ts';
import { isFinished } from '../lib/status.ts';
import { Settings } from './Settings.tsx';

export function Project({ id, tab }: { id: string; tab: ProjectTab }) {
  const { api, go } = useApp();
  const project = useLoad(() => api.get<ProjectRow>(`/projects/${id}`), [id]);
  if (project.loading) return <Loading />;
  if (!project.data) return <ErrorNote error={project.error ?? 'Not found'} />;
  const p = project.data;
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>{p.repository_name}</h1>
          <p className="muted">
            {p.branch}
            {p.project_root ? ` · ${p.project_root}` : ''}
          </p>
        </div>
      </header>
      <nav className="tabs" aria-label="App sections">
        {(['overview', 'settings', 'builds'] as const).map((t) => (
          <Link key={t} to={{ name: 'project', id, tab: t }} className={t === tab ? 'tab active' : 'tab'}>
            {t === 'overview' ? 'Build' : t === 'settings' ? 'Settings' : 'History'}
          </Link>
        ))}
      </nav>
      {tab === 'overview' && <Overview project={p} />}
      {tab === 'settings' && <Settings project={p} />}
      {tab === 'builds' && <BuildList projectId={p.id} />}
      {tab === 'settings' && (
        <div className="danger-zone">
          <ActionButton
            kind="danger"
            onRun={async () => {
              if (!window.confirm(`Delete ${p.repository_name} from Git2App? Its builds and files are deleted too. Your GitHub repository is not touched.`)) return;
              await api.del(`/projects/${p.id}`);
              go({ name: 'projects' });
            }}
          >
            Delete this app from Git2App
          </ActionButton>
        </div>
      )}
    </section>
  );
}

function Overview({ project }: { project: ProjectRow }) {
  const { api } = useApp();
  const a = useLoad(() => api.get<{ analysis: AnalysisRow | null; job: AnalysisJob | null }>(`/projects/${project.id}/analysis`), [project.id], {
    ms: 4000,
    while: (d) => !!d.job && ['QUEUED', 'RUNNING', 'ANALYZING'].includes(d.job.status),
  });
  const cfg = useLoad(() => api.get<SavedConfig | null>(`/projects/${project.id}/configuration`), [project.id]);
  if (a.loading) return <Loading />;
  const analysis = a.data?.analysis;
  const job = a.data?.job;
  const running = !!job && ['QUEUED', 'RUNNING', 'ANALYZING'].includes(job.status);
  return (
    <div className="stack-lg">
      <ErrorNote error={a.error} />
      <div className="card">
        <div className="card-head">
          <h2>Check</h2>
          <ActionButton
            kind="secondary"
            disabled={running}
            onRun={async () => {
              await api.post(`/projects/${project.id}/analyze`);
              await a.reload();
            }}
          >
            {running ? 'Checking…' : 'Check again'}
          </ActionButton>
        </div>
        {running && <p className="muted">Checking the latest code on {project.branch}. This takes about a minute.</p>}
        {job?.status === 'FAILED' && <p className="note note-error">The check failed: {job.error_message ?? 'unknown error'}</p>}
        {analysis ? <Report a={analysis} /> : !running && <p className="muted">Not checked yet.</p>}
      </div>
      {analysis && <BuildPanel project={project} analysis={analysis} config={cfg.data ?? null} />}
    </div>
  );
}

function Verdict({ label, strategy }: { label: string; strategy: string }) {
  const ok = strategy !== 'unsupported';
  return (
    <div className={`verdict ${ok ? 'ok' : 'no'}`}>
      <strong>{label}</strong>
      <span>{ok ? (strategy === 'twa' ? 'Ready (Trusted Web Activity)' : 'Ready') : 'Not possible yet'}</span>
    </div>
  );
}

function Report({ a }: { a: AnalysisRow }) {
  const r = a.analysis_report;
  const order = { blocker: 0, warning: 1, info: 2, ok: 3 } as const;
  const findings = [...r.findings].sort((x, y) => order[x.level] - order[y.level]);
  return (
    <div className="stack">
      <div className="verdicts">
        <Verdict label="Android" strategy={a.recommended_android_strategy} />
        <Verdict label="iPhone" strategy={a.recommended_ios_strategy} />
      </div>
      <p>{r.summary}</p>
      <dl className="facts">
        <dt>Made with</dt>
        <dd>{r.framework}</dd>
        <dt>Installable web app</dt>
        <dd>{r.pwa.isInstallablePwa ? 'Yes' : 'No'}</dd>
        <dt>Build command</dt>
        <dd>{r.build.buildCommand ?? 'None (static site)'}</dd>
        <dt>Built files in</dt>
        <dd>{r.build.outputDir ?? 'Unknown'}</dd>
        <dt>Checked</dt>
        <dd>
          {a.commit_sha.slice(0, 7)}, {timeAgo(a.created_at)}
        </dd>
      </dl>
      <ul className="findings">
        {findings.map((f) => (
          <li key={f.code} className={`finding finding-${f.level}`}>
            <span className="finding-level">{f.level === 'blocker' ? 'Must fix' : f.level === 'warning' ? 'Worth fixing' : f.level === 'ok' ? 'Good' : 'Note'}</span>
            <span>{f.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BuildPanel({ project, analysis, config }: { project: ProjectRow; analysis: AnalysisRow; config: SavedConfig | null }) {
  const { api, go } = useApp();
  const creds = useLoad(() => api.get<Credential[]>('/signing-credentials'), []);
  const [android, setAndroid] = useState(analysis.recommended_android_strategy !== 'unsupported');
  const [ios, setIos] = useState(false);
  const [release, setRelease] = useState(false);
  const [androidKey, setAndroidKey] = useState('');
  const [iosKey, setIosKey] = useState('');
  if (!config) {
    return (
      <div className="card">
        <h2>Build</h2>
        <p>Set the app's name, id and icon colours first.</p>
        <Link to={{ name: 'project', id: project.id, tab: 'settings' }} className="btn btn-primary">
          Open app settings
        </Link>
      </div>
    );
  }
  const keys = (pl: 'android' | 'ios') => (creds.data ?? []).filter((c) => c.platform === pl);
  return (
    <div className="card stack">
      <h2>Build</h2>
      <p className="muted">
        {config.appName} · {config.packageId} · version {config.version} ({config.buildNumber})
      </p>
      <fieldset className="choices">
        <legend>Which apps</legend>
        <label>
          <input type="checkbox" checked={android} disabled={analysis.recommended_android_strategy === 'unsupported'} onChange={(e) => setAndroid(e.target.checked)} /> Android
        </label>
        <label>
          <input type="checkbox" checked={ios} disabled={analysis.recommended_ios_strategy === 'unsupported'} onChange={(e) => setIos(e.target.checked)} /> iPhone
        </label>
      </fieldset>
      <fieldset className="choices">
        <legend>What for</legend>
        <label>
          <input type="radio" name="variant" checked={!release} onChange={() => setRelease(false)} /> Testing on my phone
        </label>
        <label>
          <input type="radio" name="variant" checked={release} onChange={() => setRelease(true)} /> The stores (signed)
        </label>
      </fieldset>
      {release && (
        <div className="stack">
          {android && (
            <KeyPicker label="Android upload key" items={keys('android')} value={androidKey} onChange={setAndroidKey} />
          )}
          {ios && <KeyPicker label="Apple certificate and profile" items={keys('ios')} value={iosKey} onChange={setIosKey} />}
        </div>
      )}
      {ios && <p className="muted">iPhone builds use a Mac and take about 20 minutes.</p>}
      <ActionButton
        disabled={!android && !ios}
        onRun={async () => {
          const platforms = [...(android ? ['android'] : []), ...(ios ? ['ios'] : [])];
          const res = await api.post<{ builds: Array<{ id: string }> }>(`/projects/${project.id}/builds`, {
            platforms,
            configuration_id: config.id,
            generate_debug: !release,
            generate_release: release,
            ...(release ? { signing: { ...(android ? { android: androidKey } : {}), ...(ios ? { ios: iosKey } : {}) } } : {}),
          });
          const first = res.builds[0];
          go(first ? { name: 'build', id: first.id } : { name: 'project', id: project.id, tab: 'builds' });
        }}
      >
        Build
      </ActionButton>
    </div>
  );
}

function KeyPicker({ label, items, value, onChange }: { label: string; items: Credential[]; value: string; onChange: (v: string) => void }) {
  if (!items.length) {
    return (
      <p className="note">
        No {label.toLowerCase()} yet. <Link to={{ name: 'keys' }}>Add it in Store keys</Link>.
      </p>
    );
  }
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {items.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label || c.credential_type}
          </option>
        ))}
      </select>
    </label>
  );
}

export function BuildList({ projectId }: { projectId: string }) {
  const { api } = useApp();
  const builds = useLoad(() => api.get<Build[]>(`/builds?project_id=${projectId}`), [projectId], { ms: 5000, while: (d) => d.some((b) => !isFinished(b.status)) });
  if (builds.loading) return <Loading />;
  return (
    <>
      <ErrorNote error={builds.error} />
      {builds.data?.length === 0 && <p className="muted">No builds yet.</p>}
      <ul className="list">
        {builds.data?.map((b) => (
          <li key={b.id}>
            <Link to={{ name: 'build', id: b.id }} className="row">
              <span className="row-main">
                <strong>
                  {b.platform === 'android' ? 'Android' : 'iPhone'} · {b.variant === 'release' ? 'store' : 'test'}
                </strong>
                <span className="muted">
                  {b.commit_sha.slice(0, 7)} · {timeAgo(b.created_at)}
                </span>
              </span>
              <StatusPill status={b.status} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
