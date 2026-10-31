/**
 * Android patches applied after `cap add android` / `cap sync` (PRD §6.3): version, permissions,
 * orientation and a custom URL scheme. Pure functions over file text; tested against the real
 * Capacitor 8.6 template in tests/fixtures/cap8.
 */

import type { AppConfiguration, NativePermission } from '@git2app/shared';
import { PERMISSION_SPECS } from './permissions.ts';
import { replaceOnce, xmlEscape } from './text.ts';

export function patchAppBuildGradle(text: string, cfg: Pick<AppConfiguration, 'version' | 'buildNumber'>): string {
  let out = replaceOnce(text, /versionCode\s+\d+/, `versionCode ${cfg.buildNumber}`, 'versionCode in app/build.gradle');
  out = replaceOnce(out, /versionName\s+"[^"]*"/, `versionName "${cfg.version}"`, 'versionName in app/build.gradle');
  return out;
}

export function androidPermissionsFor(perms: readonly NativePermission[]): string[] {
  const set = new Set<string>(['android.permission.INTERNET']);
  for (const p of perms) for (const a of PERMISSION_SPECS[p].androidPermissions) set.add(a);
  return [...set].sort();
}

export function patchAndroidManifest(text: string, cfg: Pick<AppConfiguration, 'permissions' | 'orientation' | 'urlScheme'>): string {
  // Permissions: replace the template's block with exactly the enabled set.
  const perms = androidPermissionsFor(cfg.permissions);
  const block = perms.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
  let out = replaceOnce(text, /(<!-- Permissions -->)[\s\S]*?(\n<\/manifest>)/, `$1\n\n${block}\n$2`.replace('\n\n\n', '\n\n'), 'permissions block in AndroidManifest.xml');
  if (cfg.permissions.includes('camera')) {
    // Do not filter the app out of devices without a camera; the feature is optional.
    out = out.replace('\n</manifest>', '\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>');
  }

  if (cfg.orientation !== 'default') {
    const value = cfg.orientation === 'portrait' ? 'portrait' : 'sensorLandscape';
    out = replaceOnce(out, /android:name="\.MainActivity"/, `android:name=".MainActivity"\n            android:screenOrientation="${value}"`, 'MainActivity in AndroidManifest.xml');
  }

  if (cfg.urlScheme) {
    const filter = [
      '            <intent-filter>',
      '                <action android:name="android.intent.action.VIEW" />',
      '                <category android:name="android.intent.category.DEFAULT" />',
      '                <category android:name="android.intent.category.BROWSABLE" />',
      `                <data android:scheme="${xmlEscape(cfg.urlScheme)}" />`,
      '            </intent-filter>',
      '',
    ].join('\n');
    out = replaceOnce(out, /(\n\s*<\/activity>)/, `\n${filter}$1`, 'end of MainActivity in AndroidManifest.xml');
  }
  return out;
}
