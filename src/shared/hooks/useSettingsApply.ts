import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
type PlatformInfo = {
  platform: string;
  is_windows_10: boolean;
  is_windows_11: boolean;
};

interface UseSettingsApplyOptions {
  showAppBorder: boolean;
  compactMode: boolean;
  settingsLoaded: boolean;
  clipboardItemFontSize: number;
  clipboardTagFontSize: number;
  vibrancyEnabled: boolean;
  colorMode: 'dark' | 'light' | 'system';
}

export const useSettingsApply = ({
  showAppBorder,
  compactMode,
  settingsLoaded,
  clipboardItemFontSize,
  clipboardTagFontSize,
  vibrancyEnabled,
  colorMode
}: UseSettingsApplyOptions) => {
  useEffect(() => {
    if (!settingsLoaded) return;

    const root = document.documentElement;
    const body = document.body;

    let disposed = false;

    // Hardcoded Fluent theme
    root.classList.add("theme-fluent");
    body.classList.add("theme-fluent");

    const updateColorMode = () => {
      let actualMode: 'dark' | 'light' = 'dark';
      if (colorMode === 'system') {
        actualMode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      } else {
        actualMode = colorMode;
      }

      if (actualMode === 'dark') {
        root.classList.add("dark-mode");
        body.classList.add("dark-mode");
        root.classList.remove("light-mode");
        body.classList.remove("light-mode");
      } else {
        root.classList.add("light-mode");
        body.classList.add("light-mode");
        root.classList.remove("dark-mode");
        body.classList.remove("dark-mode");
      }

      invoke("set_theme", {
        theme: "fluent",
        color_mode: actualMode,
        show_app_border: showAppBorder,
        vibrancy_enabled: vibrancyEnabled
      }).catch(console.error);
    };

    updateColorMode();

    // Listen for system theme changes if mode is system
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      if (colorMode === 'system') {
        updateColorMode();
      }
    };

    mediaQuery.addEventListener('change', listener);

    invoke<PlatformInfo>("get_platform_info")
      .then((info) => {
        if (disposed) return;
        root.classList.toggle("windows-10", !!info?.is_windows_10);
        body.classList.toggle("windows-10", !!info?.is_windows_10);
        root.classList.toggle("windows-11", !!info?.is_windows_11);
        body.classList.toggle("windows-11", !!info?.is_windows_11);
      })
      .catch(() => {
        if (disposed) return;
        root.classList.remove("windows-10", "windows-11");
        body.classList.remove("windows-10", "windows-11");
      });
      
    root.classList.toggle("hide-app-border", !showAppBorder);
    body.classList.toggle("hide-app-border", !showAppBorder);
    root.classList.toggle("vibrancy-disabled", !vibrancyEnabled);
    body.classList.toggle("vibrancy-disabled", !vibrancyEnabled);

    if (compactMode) {
      body.classList.add("compact-mode");
    } else {
      body.classList.remove("compact-mode");
    }

    return () => {
      disposed = true;
      mediaQuery.removeEventListener('change', listener);
    };
  }, [showAppBorder, compactMode, settingsLoaded, vibrancyEnabled, colorMode]);

  useEffect(() => {
    if (!settingsLoaded) return;
    const root = document.documentElement;
    root.style.setProperty("--item-font-size", `${clipboardItemFontSize}px`);
    root.style.setProperty("--tag-font-size", `${clipboardTagFontSize}px`);
  }, [clipboardItemFontSize, clipboardTagFontSize, settingsLoaded]);
};
