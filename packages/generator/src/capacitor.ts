/**
 * The Capacitor plan for one build (PRD §5.2): the generated capacitor.config.json, the exact
 * packages to add, and the notes the user must see. The config is generated per project; webDir
 * is the detected output folder, never an assumed "dist".
 */

import type { AppConfiguration } from '@git2app/shared';
import { PERMISSION_SPECS } from './permissions.ts';
import { TOOLCHAIN } from './toolchain.ts';

export interface CapacitorPlan {
  capacitorConfig: Record<string, unknown>;
  packages: Record<string, string>; // name -> exact version
  notes: string[];
}

export function capacitorPlan(cfg: AppConfiguration, webDir: string): CapacitorPlan {
  if (!webDir || webDir.split('/').includes('..') || webDir.startsWith('/')) throw new Error('webDir must be a relative folder inside the project');
  const packages: Record<string, string> = {
    '@capacitor/core': TOOLCHAIN.npm['@capacitor/core'],
    '@capacitor/cli': TOOLCHAIN.npm['@capacitor/cli'],
    '@capacitor/android': TOOLCHAIN.npm['@capacitor/android'],
    '@capacitor/ios': TOOLCHAIN.npm['@capacitor/ios'],
  };
  const notes: string[] = [];
  for (const p of cfg.permissions) {
    const spec = PERMISSION_SPECS[p];
    if (spec.plugin) packages[spec.plugin] = TOOLCHAIN.plugins[spec.plugin];
    if (spec.note) notes.push(spec.note);
    if (spec.iosUsageKeys.length && !cfg.permissionText?.[p]) {
      notes.push(`The ${p} explanation uses default text. Apple reviews these; write your own in Native capabilities.`);
    }
  }
  if (!cfg.privacyPolicyUrl) notes.push('Both stores require a privacy policy link before release.');

  const capacitorConfig: Record<string, unknown> = {
    appId: cfg.packageId,
    appName: cfg.appName,
    webDir,
    // Bundled assets are served from https://localhost, so cookies, service workers and
    // secure-context APIs behave as on the web.
    server: { androidScheme: 'https', iosScheme: 'capacitor' },
    android: { allowMixedContent: false, captureInput: true, webContentsDebuggingEnabled: false },
    ios: { contentInset: 'automatic', limitsNavigationsToAppBoundDomains: false },
    plugins: cfg.permissions.includes('notifications') ? { PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] } } : {},
  };
  if (cfg.backgroundColor) (capacitorConfig as any).backgroundColor = cfg.backgroundColor;
  return { capacitorConfig, packages, notes };
}
