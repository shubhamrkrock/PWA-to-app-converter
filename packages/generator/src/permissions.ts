/**
 * What each user-enabled permission means natively (PRD §8.3). Only permissions the user turned
 * on are applied; nothing is added "just in case" (PRD §7.4).
 *
 * A plugin is listed only where the web API does not work inside an app WebView (push, biometric
 * prompts, Bluetooth). Camera, microphone and location keep working through the WebView once the
 * permission is declared, so no extra native code is added for them. A plugin also does nothing
 * until the web app calls it, which the report says plainly (PRD §1.4).
 */

import type { NativePermission } from '@git2app/shared';
import type { PluginName } from './toolchain.ts';

export interface PermissionSpec {
  androidPermissions: string[];
  /** Info.plist usage-description keys that must carry the user's explanation. */
  iosUsageKeys: string[];
  plugin: PluginName | null;
  defaultText: (app: string) => string;
  /** Extra note shown in the report. */
  note?: string;
}

export const PERMISSION_SPECS: Record<NativePermission, PermissionSpec> = {
  camera: {
    androidPermissions: ['android.permission.CAMERA'],
    iosUsageKeys: ['NSCameraUsageDescription'],
    plugin: null,
    defaultText: (a) => `${a} uses the camera when you choose to take a photo.`,
  },
  photos: {
    androidPermissions: [], // Android's photo picker needs no permission
    iosUsageKeys: ['NSPhotoLibraryUsageDescription', 'NSPhotoLibraryAddUsageDescription'],
    plugin: null,
    defaultText: (a) => `${a} opens your photos only when you choose a picture to add.`,
  },
  location: {
    androidPermissions: ['android.permission.ACCESS_COARSE_LOCATION', 'android.permission.ACCESS_FINE_LOCATION'],
    iosUsageKeys: ['NSLocationWhenInUseUsageDescription'],
    plugin: null,
    defaultText: (a) => `${a} uses your location while you use the app, when a feature needs it.`,
  },
  microphone: {
    androidPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS'],
    iosUsageKeys: ['NSMicrophoneUsageDescription'],
    plugin: null,
    defaultText: (a) => `${a} uses the microphone when you choose to record audio.`,
  },
  notifications: {
    androidPermissions: ['android.permission.POST_NOTIFICATIONS'],
    iosUsageKeys: [],
    plugin: '@capacitor/push-notifications',
    defaultText: (a) => `${a} sends notifications you have turned on.`,
    note: 'Web Push does not work inside an app WebView. The web app must call @capacitor/push-notifications when it runs as an app, and push needs Firebase (Android) and an APNs key (iOS).',
  },
  biometrics: {
    androidPermissions: ['android.permission.USE_BIOMETRIC'],
    iosUsageKeys: ['NSFaceIDUsageDescription'],
    plugin: '@aparajita/capacitor-biometric-auth',
    defaultText: (a) => `${a} uses Face ID to unlock the app when you turn it on.`,
    note: 'Biometric unlock works only where the web app calls the biometric plugin.',
  },
  bluetooth: {
    androidPermissions: ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT'],
    iosUsageKeys: ['NSBluetoothAlwaysUsageDescription'],
    plugin: '@capacitor-community/bluetooth-le',
    defaultText: (a) => `${a} uses Bluetooth to connect to devices you choose.`,
    note: 'Web Bluetooth is not available in app WebViews; the web app must call the Bluetooth plugin.',
  },
};
