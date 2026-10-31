/**
 * Trusted Web Activity (PRD §5.1): the twa-manifest.json Bubblewrap generates its Android project
 * from, and the Digital Asset Links file the owner publishes on their domain. The user keeps
 * control of the domain; we only produce the file and the instructions.
 */

import type { AppConfiguration } from '@git2app/shared';
import { TOOLCHAIN } from './toolchain.ts';

export interface TwaInput {
  config: AppConfiguration;
  hostedOrigin: string; // https://host
  startUrl: string; // path from the web manifest, e.g. "/"
  webManifestUrl: string; // absolute
  iconUrl: string; // absolute, >= 512px
  maskableIconUrl: string | null;
  enableNotifications: boolean;
}

export function twaManifest(i: TwaInput): Record<string, unknown> {
  const host = new URL(i.hostedOrigin).host;
  const start = i.startUrl.startsWith('/') ? i.startUrl : `/${i.startUrl}`;
  return {
    packageId: i.config.packageId,
    host,
    name: i.config.appName,
    launcherName: i.config.appName.slice(0, 12),
    display: 'standalone',
    themeColor: i.config.themeColor ?? '#FFFFFF',
    themeColorDark: i.config.themeColor ?? '#000000',
    navigationColor: i.config.themeColor ?? '#000000',
    navigationColorDark: '#000000',
    navigationDividerColor: '#00000000',
    navigationDividerColorDark: '#00000000',
    backgroundColor: i.config.backgroundColor ?? '#FFFFFF',
    enableNotifications: i.enableNotifications,
    startUrl: start,
    iconUrl: i.iconUrl,
    ...(i.maskableIconUrl ? { maskableIconUrl: i.maskableIconUrl } : {}),
    splashScreenFadeOutDuration: 300,
    // The signing job signs; Bubblewrap's own key is never used for a store build.
    signingKey: { path: './unused.keystore', alias: 'unused' },
    appVersionName: i.config.version,
    appVersionCode: i.config.buildNumber,
    shortcuts: [],
    generatorApp: 'git2app',
    webManifestUrl: i.webManifestUrl,
    fallbackType: 'customtabs',
    features: {},
    alphaDependencies: { enabled: false },
    enableSiteSettingsShortcut: true,
    isChromeOSOnly: false,
    isMetaQuest: false,
    fullScopeUrl: `${i.hostedOrigin.replace(/\/$/, '')}/`,
    minSdkVersion: TOOLCHAIN.androidMinSdk,
    orientation: i.config.orientation === 'default' ? 'default' : i.config.orientation,
    fingerprints: [],
    additionalTrustedOrigins: [],
    retainedBundles: [],
    appVersion: i.config.version,
  };
}

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * /.well-known/assetlinks.json for the app's domain. With Play App Signing the owner adds Play's
 * app-signing fingerprint as well as the upload key's, so both are accepted.
 */
export function assetLinks(packageId: string, sha256Fingerprints: string[]): string {
  const fps = sha256Fingerprints.map((f) => f.toUpperCase());
  for (const f of fps) if (!FINGERPRINT.test(f)) throw new Error(`Not a SHA-256 certificate fingerprint: ${f}`);
  if (!fps.length) throw new Error('At least one signing certificate fingerprint is required');
  return (
    JSON.stringify(
      [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: packageId, sha256_cert_fingerprints: fps },
        },
      ],
      null,
      2,
    ) + '\n'
  );
}
