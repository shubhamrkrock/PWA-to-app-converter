import { useState, type FormEvent } from 'react';
import { useApp } from '../session.tsx';
import { ActionButton, ErrorNote, Loading, timeAgo, useLoad } from '../ui.tsx';
import { fileToBase64, looksLike } from '../lib/files.ts';
import type { Credential } from '../types.ts';

const TYPE_LABEL: Record<string, string> = {
  'android-keystore': 'Android upload key',
  'ios-certificate': 'Apple certificate and profile',
  'asc-api-key': 'App Store Connect key',
};

export function Keys() {
  const { api } = useApp();
  const creds = useLoad(() => api.get<Credential[]>('/signing-credentials'), []);
  const [adding, setAdding] = useState<'android' | 'ios' | null>(null);

  return (
    <section>
      <header className="page-head">
        <h1>Signing keys</h1>
      </header>
      <p className="muted">
        Store builds must be signed. Keys are locked with encryption before they are saved, and are only unlocked inside the build that uses them. Test builds don't need a key.
      </p>
      {creds.loading ? <Loading /> : <ErrorNote error={creds.error} />}
      <ul className="list">
        {creds.data?.map((c) => (
          <li key={c.id} className="row">
            <span className="row-main">
              <strong>{c.label || TYPE_LABEL[c.credential_type] || c.credential_type}</strong>
              <span className="muted">
                {TYPE_LABEL[c.credential_type] ?? c.credential_type} · added {timeAgo(c.created_at)}
              </span>
            </span>
            <ActionButton
              kind="danger"
              onRun={async () => {
                if (!confirm('Delete this key? Builds that use it will stop working. This cannot be undone.')) return;
                await api.del(`/signing-credentials/${c.id}`);
                await creds.reload();
              }}
            >
              Delete
            </ActionButton>
          </li>
        ))}
      </ul>
      {creds.data?.length === 0 && <p className="muted">No keys yet.</p>}
      {!adding && (
        <div className="actions">
          <button className="btn btn-secondary" onClick={() => setAdding('android')}>
            Add Android key
          </button>
          <button className="btn btn-secondary" onClick={() => setAdding('ios')}>
            Add Apple certificate
          </button>
        </div>
      )}
      {adding && (
        <KeyForm
          platform={adding}
          onDone={async () => {
            setAdding(null);
            await creds.reload();
          }}
          onCancel={() => setAdding(null)}
        />
      )}
    </section>
  );
}

async function readChecked(file: File | undefined, kind: 'keystore' | 'p12' | 'mobileprovision', what: string): Promise<string> {
  if (!file) throw new Error(`Choose the ${what}.`);
  const b64 = await fileToBase64(file);
  const head = Uint8Array.from(atob(b64.slice(0, 87384)), (c) => c.charCodeAt(0));
  if (!looksLike(kind, head)) throw new Error(`That doesn't look like a ${what}. Check you picked the right file.`);
  return b64;
}

function KeyForm({ platform, onDone, onCancel }: { platform: 'android' | 'ios'; onDone: () => Promise<void>; onCancel: () => void }) {
  const { api } = useApp();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim();
    const file = (k: string) => {
      const v = f.get(k);
      return v instanceof File && v.size > 0 ? v : undefined;
    };
    setBusy(true);
    setError(null);
    try {
      const payload =
        platform === 'android'
          ? { keystoreB64: await readChecked(file('keystore'), 'keystore', 'keystore file (.jks or .keystore)'), storePassword: s('storePassword'), keyAlias: s('keyAlias'), keyPassword: s('keyPassword') || s('storePassword') }
          : { p12B64: await readChecked(file('p12'), 'p12', 'certificate file (.p12)'), p12Password: s('p12Password'), profileB64: await readChecked(file('profile'), 'mobileprovision', 'provisioning profile (.mobileprovision)'), teamId: s('teamId') };
      for (const [k, v] of Object.entries(payload)) if (!v) throw new Error(`Fill in ${k.replace(/B64$/, '').replace(/([A-Z])/g, ' $1').toLowerCase()}.`);
      if (platform === 'ios' && !/^[A-Z0-9]{10}$/.test(payload.teamId as string)) throw new Error('The Team ID is 10 letters and numbers, from developer.apple.com > Membership.');
      await api.post('/signing-credentials', { platform, type: platform === 'android' ? 'android-keystore' : 'ios-certificate', label: s('label'), payload });
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>{platform === 'android' ? 'Add Android upload key' : 'Add Apple certificate'}</h2>
      <label>
        Name (for you)
        <input name="label" maxLength={80} placeholder={platform === 'android' ? 'Xpenstack upload key' : 'Distribution 2026'} />
      </label>
      {platform === 'android' ? (
        <>
          <label>
            Keystore file
            <input name="keystore" type="file" accept=".jks,.keystore,.p12" required />
          </label>
          <label>
            Keystore password
            <input name="storePassword" type="password" autoComplete="off" required />
          </label>
          <label>
            Key alias
            <input name="keyAlias" autoComplete="off" required />
          </label>
          <label>
            Key password <span className="muted">(leave empty if it's the same)</span>
            <input name="keyPassword" type="password" autoComplete="off" />
          </label>
        </>
      ) : (
        <>
          <label>
            Distribution certificate (.p12)
            <input name="p12" type="file" accept=".p12" required />
          </label>
          <label>
            Certificate password
            <input name="p12Password" type="password" autoComplete="off" required />
          </label>
          <label>
            Provisioning profile (.mobileprovision)
            <input name="profile" type="file" accept=".mobileprovision" required />
          </label>
          <label>
            Team ID
            <input name="teamId" autoComplete="off" autoCapitalize="characters" maxLength={10} required />
          </label>
        </>
      )}
      <ErrorNote error={error} />
      <div className="actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save key'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
