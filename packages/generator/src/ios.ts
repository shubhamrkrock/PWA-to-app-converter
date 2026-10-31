/**
 * iOS patches applied after `cap add ios` (PRD §7.4): version and build number, permission
 * explanations, orientations, URL scheme. Signing settings are applied only in the signing job.
 */

import type { AppConfiguration } from '@git2app/shared';
import { PERMISSION_SPECS } from './permissions.ts';
import { replaceAll, replaceOnce, xmlEscape, PatchError } from './text.ts';

export function patchPbxproj(text: string, cfg: Pick<AppConfiguration, 'version' | 'buildNumber' | 'bundleId'>): string {
  let out = replaceAll(text, /MARKETING_VERSION = [^;]+;/, `MARKETING_VERSION = ${cfg.version};`, 'MARKETING_VERSION');
  out = replaceAll(out, /CURRENT_PROJECT_VERSION = [^;]+;/, `CURRENT_PROJECT_VERSION = ${cfg.buildNumber};`, 'CURRENT_PROJECT_VERSION');
  // The bundle id may differ from the Android package id (PRD §8.1).
  out = replaceAll(out, /PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/, `PRODUCT_BUNDLE_IDENTIFIER = ${cfg.bundleId};`, 'PRODUCT_BUNDLE_IDENTIFIER');
  return out;
}

function plistKeyPresent(text: string, key: string): boolean {
  return text.includes(`<key>${key}</key>`);
}

/** Insert entries just before the root dict closes. */
function insertIntoRootDict(text: string, entries: string): string {
  const idx = text.lastIndexOf('</dict>');
  if (idx < 0) throw new PatchError('Template changed: Info.plist has no root dict');
  return text.slice(0, idx) + entries + text.slice(idx);
}

export function usageDescriptions(cfg: Pick<AppConfiguration, 'appName' | 'permissions' | 'permissionText'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of cfg.permissions) {
    const spec = PERMISSION_SPECS[p];
    const text = cfg.permissionText?.[p] ?? spec.defaultText(cfg.appName);
    for (const key of spec.iosUsageKeys) out[key] = text;
  }
  return out;
}

export function patchInfoPlist(text: string, cfg: Pick<AppConfiguration, 'appName' | 'permissions' | 'permissionText' | 'orientation' | 'urlScheme'>): string {
  let out = text;
  const usage = usageDescriptions(cfg);
  let entries = '';
  for (const [k, v] of Object.entries(usage).sort()) {
    if (plistKeyPresent(out, k)) throw new PatchError(`Info.plist already defines ${k}`);
    entries += `\t<key>${k}</key>\n\t<string>${xmlEscape(v)}</string>\n`;
  }
  if (cfg.urlScheme) {
    entries +=
      `\t<key>CFBundleURLTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n` +
      `\t\t\t\t<string>${xmlEscape(cfg.urlScheme)}</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>\n`;
  }
  if (cfg.permissions.includes('notifications')) {
    entries += `\t<key>UIBackgroundModes</key>\n\t<array>\n\t\t<string>remote-notification</string>\n\t</array>\n`;
  }
  if (entries) out = insertIntoRootDict(out, entries);

  if (cfg.orientation !== 'default') {
    const list =
      cfg.orientation === 'portrait'
        ? ['UIInterfaceOrientationPortrait']
        : ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'];
    const arr = `<array>\n${list.map((o) => `\t\t<string>${o}</string>`).join('\n')}\n\t</array>`;
    out = replaceOnce(out, /(<key>UISupportedInterfaceOrientations<\/key>\s*)<array>[\s\S]*?<\/array>/, `$1${arr}`, 'iPhone orientations');
    out = replaceOnce(out, /(<key>UISupportedInterfaceOrientations~ipad<\/key>\s*)<array>[\s\S]*?<\/array>/, `$1${arr}`, 'iPad orientations');
  }
  return out;
}

/** Entitlements file content for the capabilities in use (push needs aps-environment). */
export function entitlements(cfg: Pick<AppConfiguration, 'permissions'>, variant: 'debug' | 'release'): string | null {
  if (!cfg.permissions.includes('notifications')) return null;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>aps-environment</key>',
    `\t<string>${variant === 'release' ? 'production' : 'development'}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
