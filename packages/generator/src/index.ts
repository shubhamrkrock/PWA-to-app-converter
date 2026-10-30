export { TOOLCHAIN } from './toolchain.ts';
export { PERMISSION_SPECS } from './permissions.ts';
export { capacitorPlan, type CapacitorPlan } from './capacitor.ts';
export { patchAppBuildGradle, patchAndroidManifest, androidPermissionsFor } from './android.ts';
export { patchPbxproj, patchInfoPlist, usageDescriptions, entitlements } from './ios.ts';
export { twaManifest, assetLinks } from './twa.ts';
export { PatchError } from './text.ts';
