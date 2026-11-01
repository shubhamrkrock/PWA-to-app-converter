import { useApp } from '../session.tsx';
import { ActionButton, ErrorNote, Loading, useLoad } from '../ui.tsx';
import type { Installation } from '../types.ts';

const RESULT: Record<string, { tone: string; text: string }> = {
  connected: { tone: 'ok', text: 'GitHub is connected. You can now pick a repository.' },
  failed: { tone: 'error', text: 'GitHub did not finish connecting. Please try again.' },
  forbidden: { tone: 'error', text: 'That GitHub install belongs to another account, so it was not connected.' },
};

export function Integrations({ github }: { github: string | null }) {
  const { api } = useApp();
  const insts = useLoad(() => api.get<Installation[]>('/github/installations'), []);
  const result = github ? RESULT[github] : undefined;

  return (
    <section>
      <header className="page-head">
        <h1>GitHub</h1>
      </header>
      {result && (
        <p className={`note note-${result.tone}`} role="status">
          {result.text}
        </p>
      )}
      <div className="card">
        <p>Git2App reads your code through a GitHub App. It only gets read access, and only to the repositories you choose.</p>
        <ActionButton
          onRun={async () => {
            const { url } = await api.get<{ url: string }>('/github/install-url');
            location.assign(url);
          }}
        >
          {insts.data && insts.data.length > 0 ? 'Add another account' : 'Connect GitHub'}
        </ActionButton>
      </div>
      {insts.loading ? (
        <Loading />
      ) : (
        <>
          <ErrorNote error={insts.error} />
          <ul className="list">
            {insts.data?.map((i) => (
              <li key={i.installation_id} className="row">
                <span className="row-main">
                  <strong>{i.account_name}</strong>
                  <span className="muted">{i.account_type === 'Organization' ? 'Organisation' : 'Personal account'}</span>
                </span>
                <ActionButton
                  kind="secondary"
                  onRun={async () => {
                    if (!confirm(`Stop using ${i.account_name}? Automatic builds for its apps turn off.`)) return;
                    const r = await api.del<{ revokeAt: string }>(`/github/installations/${i.installation_id}`);
                    await insts.reload();
                    if (confirm('Disconnected. Also remove the app on GitHub? (Opens GitHub.)')) open(r.revokeAt, '_blank', 'noopener');
                  }}
                >
                  Disconnect
                </ActionButton>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
