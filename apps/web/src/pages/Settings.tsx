import { useEffect, useState } from 'react';
import { PERMISSIONS, type NativePermission } from '@git2app/shared';
import { useApp } from '../session.tsx';
import { ErrorNote, Loading } from '../ui.tsx';
import { ApiError } from '../lib/api.ts';
import { defaultForm, formErrors, formFromConfig, payloadFromForm, PERMISSION_LABEL, type ConfigForm } from '../lib/config-form.ts';
import type { AnalysisRow, Project, SavedConfig } from '../types.ts';

export function Settings({ project }: { project: Project }) {
  const { api } = useApp();
  const [form, setForm] = useState<ConfigForm | null>(null);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await api.get<SavedConfig | null>(`/projects/${project.id}/configuration`);
        if (cfg) return setForm(formFromConfig(cfg));
        const a = await api.get<{ analysis: AnalysisRow | null }>(`/projects/${project.id}/analysis`);
        setForm(defaultForm(project.repository_name, a.analysis?.analysis_report.pwa.manifest ?? null));
      } catch (e) {
        setError(e);
      }
    })();
  }, [api, project.id, project.repository_name]);

  if (!form) return error ? <ErrorNote error={error} /> : <Loading />;
  const errors = touched ? { ...formErrors(form), ...serverErrors } : serverErrors;
  const set = <K extends keyof ConfigForm>(k: K, v: ConfigForm[K]) => {
    setForm({ ...form, [k]: v });
    setSaved(false);
    setServerErrors({});
  };
  const togglePerm = (p: NativePermission) => set('permissions', form.permissions.includes(p) ? form.permissions.filter((x) => x !== p) : [...form.permissions, p]);

  const field = (key: keyof ConfigForm, label: string, input: React.ReactNode, hint?: string) => (
    <label className={`field ${errors[key] ? 'has-error' : ''}`}>
      <span>{label}</span>
      {input}
      {errors[key] ? <small className="error">{errors[key]}</small> : hint ? <small className="muted">{hint}</small> : null}
    </label>
  );

  return (
    <form
      className="stack card"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setTouched(true);
        if (Object.keys(formErrors(form)).length) return;
        setBusy(true);
        setError(null);
        try {
          await api.post(`/projects/${project.id}/configuration`, payloadFromForm(form));
          setSaved(true);
        } catch (err) {
          if (err instanceof ApiError && err.fields) setServerErrors(err.fields);
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>App settings</h2>
      {field('appName', 'App name', <input value={form.appName} maxLength={30} onChange={(e) => set('appName', e.target.value)} />, 'Shown under the icon. Up to 30 characters.')}
      {field(
        'packageId',
        'App id',
        <input value={form.packageId} autoCapitalize="off" spellCheck={false} onChange={(e) => set('packageId', e.target.value)} />,
        'Like com.yourname.app. It can never change once the app is in a store.',
      )}
      <label className="check">
        <input type="checkbox" checked={form.sameId} onChange={(e) => set('sameId', e.target.checked)} /> Use the same id on iPhone
      </label>
      {!form.sameId &&
        field('bundleId', 'iPhone app id', <input value={form.bundleId} autoCapitalize="off" spellCheck={false} onChange={(e) => set('bundleId', e.target.value)} />)}
      <div className="grid-2">
        {field('version', 'Version', <input value={form.version} inputMode="decimal" onChange={(e) => set('version', e.target.value)} />, 'Like 1.0.0')}
        {field('buildNumber', 'Build number', <input value={form.buildNumber} inputMode="numeric" onChange={(e) => set('buildNumber', e.target.value)} />, 'Goes up by one for every store upload.')}
      </div>
      <div className="grid-2">
        {field('themeColor', 'Top bar colour', <input type="color" value={form.themeColor} onChange={(e) => set('themeColor', e.target.value.toUpperCase())} />)}
        {field('backgroundColor', 'Icon and splash background', <input type="color" value={form.backgroundColor} onChange={(e) => set('backgroundColor', e.target.value.toUpperCase())} />)}
      </div>
      {field(
        'orientation',
        'Screen',
        <select value={form.orientation} onChange={(e) => set('orientation', e.target.value as ConfigForm['orientation'])}>
          <option value="portrait">Upright only</option>
          <option value="landscape">Sideways only</option>
          <option value="default">Turns with the phone</option>
        </select>,
      )}
      <fieldset className="choices">
        <legend>What the app may ask for</legend>
        {PERMISSIONS.map((p) => (
          <div key={p} className="perm">
            <label>
              <input type="checkbox" checked={form.permissions.includes(p)} onChange={() => togglePerm(p)} /> {PERMISSION_LABEL[p]}
            </label>
            {form.permissions.includes(p) && (
              <input
                className="perm-text"
                placeholder={`Why, in your words (shown by the phone). Example: "Take a photo of a receipt."`}
                value={form.permissionText[p] ?? ''}
                onChange={(e) => set('permissionText', { ...form.permissionText, [p]: e.target.value })}
              />
            )}
          </div>
        ))}
        {errors.permissionText && <small className="error">{errors.permissionText}</small>}
      </fieldset>
      {field(
        'urlScheme',
        'Link name (optional)',
        <input value={form.urlScheme} autoCapitalize="off" spellCheck={false} placeholder="xpenstack" onChange={(e) => set('urlScheme', e.target.value)} />,
        'Lets links like xpenstack://… open the app, for example after signing in.',
      )}
      {field(
        'privacyPolicyUrl',
        'Privacy policy link',
        <input type="url" value={form.privacyPolicyUrl} placeholder="https://…" onChange={(e) => set('privacyPolicyUrl', e.target.value)} />,
        'Both stores ask for one.',
      )}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </button>
      {saved && <p className="note">Saved. The next build uses these settings.</p>}
      <ErrorNote error={error} />
    </form>
  );
}
