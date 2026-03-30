import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UseSettingsSyncOptions {
  settingsLoaded: boolean;
  deduplicate: boolean;
  saveAppSetting: (type: string, path: string) => Promise<void>;
  captureFiles: boolean;
  captureRichText: boolean;
  persistent: boolean;
  soundVolume: number;
  vibrancyEnabled: boolean;
  arrowKeySelection: boolean;
  setIsKeyboardMode: Dispatch<SetStateAction<boolean>>;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  colorMode: 'dark' | 'light' | 'system';
}

export const useSettingsSync = ({
  settingsLoaded,
  deduplicate,
  saveAppSetting,
  captureFiles,
  captureRichText,
  persistent,
  soundVolume,
  vibrancyEnabled,
  arrowKeySelection,
  setIsKeyboardMode,
  setSelectedIndex,
  colorMode
}: UseSettingsSyncOptions) => {
  useEffect(() => {
    if (!settingsLoaded) return;
    invoke("set_deduplication", { enabled: deduplicate }).catch(console.error);
    saveAppSetting('deduplicate', deduplicate.toString());
  }, [deduplicate, settingsLoaded, saveAppSetting]);

  useEffect(() => {
    if (!settingsLoaded) return;
    invoke("set_capture_files", { enabled: captureFiles }).catch(console.error);
    saveAppSetting('capture_files', captureFiles.toString());
  }, [captureFiles, settingsLoaded, saveAppSetting]);

  useEffect(() => {
    if (!settingsLoaded) return;
    invoke("set_capture_rich_text", { enabled: captureRichText }).catch(console.error);
    saveAppSetting('capture_rich_text', captureRichText.toString());
  }, [captureRichText, settingsLoaded, saveAppSetting]);

  useEffect(() => {
    if (!settingsLoaded) return;
    invoke("set_persistence", { enabled: persistent }).catch(console.error);
    saveAppSetting('persistent', persistent.toString());
  }, [persistent, settingsLoaded, saveAppSetting]);

  useEffect(() => {
    if (!settingsLoaded) return;
    saveAppSetting('sound_volume', soundVolume.toString());
  }, [soundVolume, settingsLoaded, saveAppSetting]);

  useEffect(() => {
    if (!settingsLoaded) return;
    saveAppSetting('vibrancy_enabled', vibrancyEnabled.toString());
  }, [vibrancyEnabled, settingsLoaded, saveAppSetting]);

  useEffect(() => {
    if (!settingsLoaded) return;
    saveAppSetting('color_mode', colorMode);
  }, [colorMode, settingsLoaded, saveAppSetting]);

  useEffect(() => {
    if (!settingsLoaded) return;
    saveAppSetting('arrow_key_selection', arrowKeySelection.toString());
    if (!arrowKeySelection) {
      setIsKeyboardMode(false);
      setSelectedIndex(0);
    }
  }, [arrowKeySelection, settingsLoaded, saveAppSetting, setIsKeyboardMode, setSelectedIndex]);
};
