import { create } from 'zustand';
import type { Locale } from '../types';
import type { DefaultAppsMap, InstalledAppOption } from '../../features/app/types';

interface SettingsState {
  // Appearance
  language: Locale;
  theme: string;
  colorMode: 'dark' | 'light' | 'system';
  compactMode: boolean;
  vibrancyEnabled: boolean;
  showAppBorder: boolean;
  showSourceAppIcon: boolean;
  clipboardItemFontSize: number;
  clipboardTagFontSize: number;
  
  // General
  autoStart: boolean;
  silentStart: boolean;
  hideTrayIcon: boolean;
  edgeDocking: boolean;
  followMouse: boolean;
  arrowKeySelection: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  pasteSoundEnabled: boolean;
  
  // Clipboard Logic
  deduplicate: boolean;
  persistent: boolean;
  persistentLimitEnabled: boolean;
  persistentLimit: number;
  deleteAfterPaste: boolean;
  moveToTopAfterPaste: boolean;
  pasteMethod: string;
  captureFiles: boolean;
  captureRichText: boolean;
  richTextSnapshotPreview: boolean;
  
  // Privacy
  privacyProtection: boolean;
  privacyProtectionKinds: string[];
  privacyProtectionCustomRules: string;
  
  // Hotkeys
  hotkey: string;
  sequentialHotkey: string;
  richPasteHotkey: string;
  searchHotkey: string;
  
  // Data/System
  dataPath: string;
  installedApps: InstalledAppOption[];
  defaultApps: DefaultAppsMap;
  winClipboardDisabled: boolean;
  registryWinVEnabled: boolean;
  settingsLoaded: boolean;
  sequentialMode: boolean;

  // Actions
  setLanguage: (lang: Locale) => void;
  setColorMode: (mode: 'dark' | 'light' | 'system') => void;
  setCompactMode: (enabled: boolean) => void;
  setVibrancyEnabled: (enabled: boolean) => void;
  setShowAppBorder: (enabled: boolean) => void;
  setShowSourceAppIcon: (enabled: boolean) => void;
  setClipboardItemFontSize: (size: number) => void;
  setClipboardTagFontSize: (size: number) => void;
  setAutoStart: (enabled: boolean) => void;
  setSilentStart: (enabled: boolean) => void;
  setHideTrayIcon: (enabled: boolean) => void;
  setEdgeDocking: (enabled: boolean) => void;
  setFollowMouse: (enabled: boolean) => void;
  setArrowKeySelection: (enabled: boolean) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setSoundVolume: (volume: number) => void;
  setPasteSoundEnabled: (enabled: boolean) => void;
  setDeduplicate: (enabled: boolean) => void;
  setPersistent: (enabled: boolean) => void;
  setPersistentLimitEnabled: (enabled: boolean) => void;
  setPersistentLimit: (limit: number) => void;
  setDeleteAfterPaste: (enabled: boolean) => void;
  setMoveToTopAfterPaste: (enabled: boolean) => void;
  setPasteMethod: (method: string) => void;
  setCaptureFiles: (enabled: boolean) => void;
  setCaptureRichText: (enabled: boolean) => void;
  setRichTextSnapshotPreview: (enabled: boolean) => void;
  setPrivacyProtection: (enabled: boolean) => void;
  setPrivacyProtectionKinds: (kinds: string[]) => void;
  setPrivacyProtectionCustomRules: (rules: string) => void;
  setHotkey: (key: string) => void;
  setSequentialHotkey: (key: string) => void;
  setRichPasteHotkey: (key: string) => void;
  setSearchHotkey: (key: string) => void;
  setDataPath: (path: string) => void;
  setInstalledApps: (apps: InstalledAppOption[]) => void;
  setDefaultApps: (apps: DefaultAppsMap | ((prev: DefaultAppsMap) => DefaultAppsMap)) => void;
  setWinClipboardDisabled: (disabled: boolean) => void;
  setRegistryWinVEnabled: (enabled: boolean) => void;
  setSettingsLoaded: (loaded: boolean) => void;
  setSequentialModeState: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  language: 'zh',
  theme: 'fluent',
  colorMode: 'dark',
  compactMode: false,
  vibrancyEnabled: true,
  showAppBorder: true,
  showSourceAppIcon: true,
  clipboardItemFontSize: 13,
  clipboardTagFontSize: 10,
  autoStart: true,
  silentStart: true,
  hideTrayIcon: false,
  edgeDocking: false,
  followMouse: true,
  arrowKeySelection: true,
  soundEnabled: false,
  soundVolume: 70,
  pasteSoundEnabled: true,
  deduplicate: true,
  persistent: true,
  persistentLimitEnabled: true,
  persistentLimit: 1000,
  deleteAfterPaste: false,
  moveToTopAfterPaste: true,
  pasteMethod: 'shift_insert',
  captureFiles: true,
  captureRichText: false,
  richTextSnapshotPreview: false,
  privacyProtection: true,
  privacyProtectionKinds: ["phone", "idcard", "email", "secret"],
  privacyProtectionCustomRules: "",
  hotkey: "Alt+C",
  sequentialHotkey: "Alt+V",
  richPasteHotkey: "Ctrl+Shift+Z",
  searchHotkey: "Alt+F",
  dataPath: "",
  installedApps: [],
  defaultApps: {},
  winClipboardDisabled: false,
  registryWinVEnabled: false,
  settingsLoaded: false,
  sequentialMode: false,

  setLanguage: (language) => set({ language }),
  setColorMode: (colorMode) => set({ colorMode }),
  setCompactMode: (compactMode) => set({ compactMode }),
  setVibrancyEnabled: (vibrancyEnabled) => set({ vibrancyEnabled }),
  setShowAppBorder: (showAppBorder) => set({ showAppBorder }),
  setShowSourceAppIcon: (showSourceAppIcon) => set({ showSourceAppIcon }),
  setClipboardItemFontSize: (clipboardItemFontSize) => set({ clipboardItemFontSize }),
  setClipboardTagFontSize: (clipboardTagFontSize) => set({ clipboardTagFontSize }),
  setAutoStart: (autoStart) => set({ autoStart }),
  setSilentStart: (silentStart) => set({ silentStart }),
  setHideTrayIcon: (hideTrayIcon) => set({ hideTrayIcon }),
  setEdgeDocking: (edgeDocking) => set({ edgeDocking }),
  setFollowMouse: (followMouse) => set({ followMouse }),
  setArrowKeySelection: (arrowKeySelection) => set({ arrowKeySelection }),
  setSoundEnabled: (soundEnabled) => set({ soundEnabled }),
  setSoundVolume: (soundVolume) => set({ soundVolume }),
  setPasteSoundEnabled: (pasteSoundEnabled) => set({ pasteSoundEnabled }),
  setDeduplicate: (deduplicate) => set({ deduplicate }),
  setPersistent: (persistent) => set({ persistent }),
  setPersistentLimitEnabled: (persistentLimitEnabled) => set({ persistentLimitEnabled }),
  setPersistentLimit: (persistentLimit) => set({ persistentLimit }),
  setDeleteAfterPaste: (deleteAfterPaste) => set({ deleteAfterPaste }),
  setMoveToTopAfterPaste: (moveToTopAfterPaste) => set({ moveToTopAfterPaste }),
  setPasteMethod: (pasteMethod) => set({ pasteMethod }),
  setCaptureFiles: (captureFiles) => set({ captureFiles }),
  setCaptureRichText: (captureRichText) => set({ captureRichText }),
  setRichTextSnapshotPreview: (richTextSnapshotPreview) => set({ richTextSnapshotPreview }),
  setPrivacyProtection: (privacyProtection) => set({ privacyProtection }),
  setPrivacyProtectionKinds: (privacyProtectionKinds) => set({ privacyProtectionKinds }),
  setPrivacyProtectionCustomRules: (privacyProtectionCustomRules) => set({ privacyProtectionCustomRules }),
  setHotkey: (hotkey) => set({ hotkey }),
  setSequentialHotkey: (sequentialHotkey) => set({ sequentialHotkey }),
  setRichPasteHotkey: (richPasteHotkey) => set({ richPasteHotkey }),
  setSearchHotkey: (searchHotkey) => set({ searchHotkey }),
  setDataPath: (dataPath) => set({ dataPath }),
  setInstalledApps: (installedApps) => set({ installedApps }),
  setDefaultApps: (apps) => set((state) => ({ 
    defaultApps: typeof apps === 'function' ? apps(state.defaultApps) : apps 
  })),
  setWinClipboardDisabled: (winClipboardDisabled) => set({ winClipboardDisabled }),
  setRegistryWinVEnabled: (registryWinVEnabled) => set({ registryWinVEnabled }),
  setSettingsLoaded: (settingsLoaded) => set({ settingsLoaded }),
  setSequentialModeState: (sequentialMode) => set({ sequentialMode }),
}));
