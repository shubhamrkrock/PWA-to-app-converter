/** The app settings form: sensible defaults from the repo and analysis, and its payload. */
import { PERMISSIONS, validateConfig, type AppConfiguration, type NativePermission } from '@git2app/shared';

export interface ConfigForm {
  appName: string;
  packageId: string;
  bundleId: string;
  sameId: boolean;
  version: string;
  buildNumber: string;
  themeColor: string;
  backgroundColor: string;
  orientation: 'default' | 'portrait' | 'landscape';
  permissions: NativePermission[];
  permissionText: Partial<Record<NativePermission, string>>;
  urlScheme: string;
  privacyPolicyUrl: string;
}

/** "shubhamrkrock/Xpenstack" -> "com.shubhamrkrock.xpenstack": lower case, letters and digits. */
export function suggestId(fullName: string): string {
  const seg = (s: string) => {
    const clean = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return /^[a-z]/.test(clean) ? clean : `app${clean}`;
  };
  const [owner = 'app', repo = 'app'] = fullName.split('/');
  return `com.${seg(owner)}.${seg(repo)}`;
}

function title(repo: string): string {
  return repo.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 30);
}

const HEX = /^#[0-9a-f]{6}$/i;

export function defaultForm(fullName: string, manifest?: { themeColor: string | null; backgroundColor: string | null } | null): ConfigForm {
  const id = suggestId(fullName);
  return {
    appName: title(fullName.split('/')[1] ?? fullName),
    packageId: id,
    bundleId: id,
    sameId: true,
    version: '1.0.0',
    buildNumber: '1',
    themeColor: manifest?.themeColor && HEX.test(manifest.themeColor) ? manifest.themeColor : '#FFFFFF',
    backgroundColor: manifest?.backgroundColor && HEX.test(manifest.backgroundColor) ? manifest.backgroundColor : '#FFFFFF',
    orientation: 'portrait',
    permissions: [],
    permissionText: {},
    urlScheme: '',
    privacyPolicyUrl: '',
  };
}

export function formFromConfig(c: AppConfiguration): ConfigForm {
  return {
    appName: c.appName,
    packageId: c.packageId,
    bundleId: c.bundleId,
    sameId: c.packageId === c.bundleId,
    version: c.version,
    buildNumber: String(c.buildNumber),
    themeColor: c.themeColor ?? '#FFFFFF',
    backgroundColor: c.backgroundColor ?? '#FFFFFF',
    orientation: c.orientation,
    permissions: [...c.permissions],
    permissionText: { ...(c.permissionText ?? {}) },
    urlScheme: c.urlScheme ?? '',
    privacyPolicyUrl: c.privacyPolicyUrl ?? '',
  };
}

export function payloadFromForm(f: ConfigForm): Partial<AppConfiguration> {
  const permissionText: Partial<Record<NativePermission, string>> = {};
  for (const p of f.permissions) if (f.permissionText[p]?.trim()) permissionText[p] = f.permissionText[p]!.trim();
  return {
    appName: f.appName.trim(),
    packageId: f.packageId.trim(),
    bundleId: (f.sameId ? f.packageId : f.bundleId).trim(),
    version: f.version.trim(),
    buildNumber: Number(f.buildNumber),
    iconPath: null,
    splashPath: null,
    themeColor: f.themeColor,
    backgroundColor: f.backgroundColor,
    orientation: f.orientation,
    permissions: PERMISSIONS.filter((p) => f.permissions.includes(p)),
    permissionText,
    urlScheme: f.urlScheme.trim() || null,
    privacyPolicyUrl: f.privacyPolicyUrl.trim() || null,
  };
}

/** The same rules the API applies, so mistakes show while typing. Keys are form field names. */
export function formErrors(f: ConfigForm): Record<string, string> {
  const v = validateConfig(payloadFromForm(f));
  if (v.ok) return {};
  const out: Record<string, string> = {};
  for (const [k, msg] of Object.entries(v.errors)) {
    const key = k === 'bundleId' && f.sameId ? 'packageId' : k;
    out[key] ??= String(msg);
  }
  return out;
}

export const PERMISSION_LABEL: Record<NativePermission, string> = {
  camera: 'Camera',
  location: 'Location',
  microphone: 'Microphone',
  notifications: 'Notifications',
  photos: 'Photo library',
  biometrics: 'Face ID / fingerprint',
  bluetooth: 'Bluetooth',
};
