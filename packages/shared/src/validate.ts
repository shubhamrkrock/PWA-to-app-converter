/**
 * Validation of user-entered app configuration (PRD §6.3, §7.4, §8). Pure; the API rejects bad
 * input with these messages and the generator re-checks before writing native files, so a
 * config that reaches a build worker is always well-formed.
 */

import type { AppConfiguration, NativePermission } from './types.ts';

export const PERMISSIONS: readonly NativePermission[] = ['camera', 'location', 'microphone', 'notifications', 'photos', 'biometrics', 'bluetooth'];

// Java/Kotlin reserved words are not allowed as Android package segments.
const JAVA_RESERVED = new Set(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null'.split(' '),
);

export function validatePackageId(id: string): string | null {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(id)) {
    return 'Package ID must look like com.company.app: at least two parts, each starting with a letter.';
  }
  if (id.length > 150) return 'Package ID is too long.';
  const bad = id.split('.').find((s) => JAVA_RESERVED.has(s));
  if (bad) return `Package ID part "${bad}" is a reserved Java word.`;
  return null;
}

export function validateBundleId(id: string): string | null {
  if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+$/.test(id)) return 'Bundle ID must look like com.company.app (letters, digits, hyphens and dots).';
  if (id.length > 155) return 'Bundle ID is too long.';
  return null;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface ConfigErrors {
  [field: string]: string;
}

/** Validate and normalise a config. Returns errors keyed by field, or the clean config. */
export function validateConfig(input: Partial<AppConfiguration>): { ok: true; config: AppConfiguration } | { ok: false; errors: ConfigErrors } {
  const e: ConfigErrors = {};
  const appName = (input.appName ?? '').trim();
  if (!appName) e.appName = 'App name is required.';
  else if (appName.length > 30) e.appName = 'App name must be 30 characters or fewer (Play and App Store limit).';

  const packageId = (input.packageId ?? '').trim();
  const pErr = validatePackageId(packageId);
  if (pErr) e.packageId = pErr;

  const bundleId = (input.bundleId ?? packageId).trim();
  const bErr = validateBundleId(bundleId);
  if (bErr) e.bundleId = bErr;

  const version = (input.version ?? '1.0.0').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) e.version = 'Version must be three numbers, like 1.0.0.';

  const buildNumber = input.buildNumber ?? 1;
  if (!Number.isInteger(buildNumber) || buildNumber < 1 || buildNumber > 2_100_000_000) {
    e.buildNumber = 'Build number must be a whole number from 1 to 2100000000 (Play limit).';
  }

  for (const k of ['themeColor', 'backgroundColor'] as const) {
    const v = input[k];
    if (v != null && !HEX.test(v)) e[k] = 'Colour must be a hex value like #1A2B3C.';
  }

  const orientation = input.orientation ?? 'default';
  if (!['default', 'portrait', 'landscape'].includes(orientation)) e.orientation = 'Orientation must be default, portrait or landscape.';

  const permissions = [...new Set(input.permissions ?? [])];
  const unknown = permissions.filter((p) => !PERMISSIONS.includes(p));
  if (unknown.length) e.permissions = `Unknown permissions: ${unknown.join(', ')}.`;

  const privacyPolicyUrl = input.privacyPolicyUrl ?? null;
  if (privacyPolicyUrl !== null && !/^https:\/\/[^\s]+$/.test(privacyPolicyUrl)) e.privacyPolicyUrl = 'Privacy policy must be an https:// link.';

  if (Object.keys(e).length) return { ok: false, errors: e };
  return {
    ok: true,
    config: {
      appName,
      packageId,
      bundleId,
      version,
      buildNumber,
      iconPath: input.iconPath ?? null,
      splashPath: input.splashPath ?? null,
      themeColor: input.themeColor ?? null,
      backgroundColor: input.backgroundColor ?? null,
      orientation: orientation as AppConfiguration['orientation'],
      permissions: permissions.sort(),
      privacyPolicyUrl,
    },
  };
}

/** Android versionCode derived when the user does not set one: stable and increasing. */
export function versionCodeFor(version: string, buildNumber: number): number {
  const [maj, min, pat] = version.split('.').map(Number) as [number, number, number];
  return Math.min(2_100_000_000, maj * 10_000_000 + min * 100_000 + pat * 1_000 + (buildNumber % 1000));
}
