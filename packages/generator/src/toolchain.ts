/**
 * Every tool version a build uses, pinned exactly (PRD §19 reproducibility). The build records
 * TOOLCHAIN_ID in its metadata, so a later rebuild of the same commit and config uses the same
 * native template. Bump deliberately, in one commit, with the e2e workflow green.
 */

export const TOOLCHAIN = {
  id: '2026.10-cap8.6',
  node: '22',
  java: '21',
  androidCompileSdk: 36,
  androidTargetSdk: 36, // Play requires a recent target; Capacitor 8.6 template default
  androidMinSdk: 24,
  iosDeploymentTarget: '15.0',
  xcode: '26', // major version on the macOS runner image
  npm: {
    '@capacitor/cli': '8.6.0',
    '@capacitor/core': '8.6.0',
    '@capacitor/android': '8.6.0',
    '@capacitor/ios': '8.6.0',
    '@capacitor/assets': '4.0.0',
    '@bubblewrap/cli': '1.27.0',
  },
  plugins: {
    '@capacitor/push-notifications': '8.1.3',
    '@aparajita/capacitor-biometric-auth': '10.0.0',
    '@capacitor-community/bluetooth-le': '8.3.0',
  },
} as const;

export type PluginName = keyof typeof TOOLCHAIN.plugins;
