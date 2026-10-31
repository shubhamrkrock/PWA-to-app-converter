import { useApp } from '../session.tsx';
import { Link, Loading, ErrorNote, useLoad, timeAgo } from '../ui.tsx';
import type { Installation, Project } from '../types.ts';

export function Projects() {
  const { api } = useApp();
  const projects = useLoad(() => api.get<Project[]>('/projects'), []);
  const insts = useLoad(() => api.get<Installation[]>('/github/installations'), []);

  if (projects.loading || insts.loading) return <Loading />;
  return (
    <section>
      <header className="page-head">
        <h1>Your apps</h1>
        {insts.data && insts.data.length > 0 && (
          <Link to={{ name: 'new-project' }} className="btn btn-primary">
            New app
          </Link>
        )}
      </header>
      <ErrorNote error={projects.error ?? insts.error} />
      {insts.data && insts.data.length === 0 && (
        <div className="card empty">
          <h2>First, connect GitHub</h2>
          <p>Git2App reads your web app's code from GitHub. It never changes it.</p>
          <Link to={{ name: 'integrations', github: null }} className="btn btn-primary">
            Connect GitHub
          </Link>
        </div>
      )}
      {insts.data && insts.data.length > 0 && projects.data?.length === 0 && (
        <div className="card empty">
          <h2>No apps yet</h2>
          <p>Pick a repository and Git2App checks whether it can become an app.</p>
          <Link to={{ name: 'new-project' }} className="btn btn-primary">
            New app
          </Link>
        </div>
      )}
      <ul className="list">
        {projects.data?.map((p) => (
          <li key={p.id}>
            <Link to={{ name: 'project', id: p.id, tab: 'overview' }} className="row">
              <span className="row-main">
                <strong>{p.repository_name}</strong>
                <span className="muted">
                  {p.branch}
                  {p.project_root ? ` · ${p.project_root}` : ''}
                </span>
              </span>
              <span className="muted">{timeAgo(p.created_at)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
