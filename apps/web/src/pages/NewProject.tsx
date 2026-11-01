import { useMemo, useState } from 'react';
import { useApp } from '../session.tsx';
import { ErrorNote, Loading, useLoad } from '../ui.tsx';
import type { Project, Repo } from '../types.ts';
import { orderBranches } from '../lib/branches.ts';

export function NewProject() {
  const { api, go } = useApp();
  const repos = useLoad(() => api.get<Repo[]>('/github/repositories'), []);
  const [filter, setFilter] = useState('');
  const [repo, setRepo] = useState<Repo | null>(null);
  const [branch, setBranch] = useState('');
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const branches = useLoad(
    () => (repo ? api.get<Array<{ name: string }>>(`/github/repositories/${repo.id}/branches?installation_id=${repo.installationId}`) : Promise.resolve([])),
    [repo?.id],
  );
  const shown = useMemo(() => (repos.data ?? []).filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase())), [repos.data, filter]);

  if (repos.loading) return <Loading label="Loading your repositories…" />;
  return (
    <section>
      <h1>New app</h1>
      <ErrorNote error={repos.error} />
      {!repo ? (
        <>
          <label className="field">
            <span>Find a repository</span>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="xpenstack" />
          </label>
          <ul className="list">
            {shown.map((r) => (
              <li key={`${r.installationId}:${r.id}`}>
                <button
                  className="row"
                  onClick={() => {
                    setRepo(r);
                    setBranch(r.defaultBranch);
                  }}
                >
                  <span className="row-main">
                    <strong>{r.fullName}</strong>
                    <span className="muted">{r.description ?? r.language ?? ''}</span>
                  </span>
                  <span className="pill pill-muted">{r.visibility}</span>
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 && <p className="muted">No repositories match. To add more, change which repositories the Git2App GitHub app can see.</p>}
        </>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const p = await api.post<Project>('/projects', { installationId: repo.installationId, repositoryId: repo.id, branch, projectRoot: root });
              await api.post(`/projects/${p.id}/analyze`);
              go({ name: 'project', id: p.id, tab: 'overview' });
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p>
            <strong>{repo.fullName}</strong>{' '}
            <button type="button" className="link" onClick={() => setRepo(null)}>
              change
            </button>
          </p>
          <label className="field">
            <span>Branch</span>
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              {orderBranches((branches.data ?? []).map((b) => b.name), repo.defaultBranch).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Folder of the web app</span>
            <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="Leave empty if it is the whole repository" />
            <small className="muted">Only for repositories with several apps, like apps/web.</small>
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Starting…' : 'Add and check it'}
          </button>
          <ErrorNote error={error} />
        </form>
      )}
    </section>
  );
}
