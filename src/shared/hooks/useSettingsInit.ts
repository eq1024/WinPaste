import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../store/settingsStore";
import type { Locale } from "../../shared/types";

export const useSettingsInit = () => {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const {
    setHotkey,
    setCompactMode,
    setLanguage,
    setColorMode,
    setStickyEnabled,
    setAppSettings,
    setSettingsLoadError
  } = useSettingsStore();

  useEffect(() => {
    let disposed = false;

    try {
      const storedCompactMode = localStorage.getItem('winpaste_compact_mode');
      if (storedCompactMode && !disposed) {
        setCompactMode(storedCompactMode === 'true');
      }
    } catch (e) {}

    invoke<Record<string, string>>("get_settings")
      .then((res) => {
        if (disposed) return;
        setSettingsLoadError(null);
        setSettings(res);
        setAppSettings(res);

        if (res["app.hotkey"]) setHotkey(res["app.hotkey"]);
        if (res["app.compact_mode"]) {
            setCompactMode(res["app.compact_mode"] === 'true');
            try { localStorage.setItem('winpaste_compact_mode', res["app.compact_mode"]); } catch(e) {}
        }
        if (res["app.sticky_enabled"]) setStickyEnabled(res["app.sticky_enabled"] === "true");
        if (res["app.color_mode"]) {
          setColorMode(res["app.color_mode"] as 'dark' | 'light' | 'system');
        }
        if (res["app.language"]) {
           setLanguage(res["app.language"] as Locale);
        } else {
           // 用户未在应用内设置过语言：
           // 优先跟随安装程序的语言选择（NSIS 写入注册表），
           // 否则回退到系统语言。
           const applySystemLanguage = () => {
              const sysLang = navigator.language.toLowerCase();
              if (sysLang.startsWith('zh')) {
                if (sysLang.includes('tw') || sysLang.includes('hk') || sysLang.includes('mo')) {
                  setLanguage('tw');
                } else {
                  setLanguage('zh');
                }
              } else {
                  setLanguage('en');
              }
           };
           invoke<string | null>("get_installer_language")
             .then((installerLang) => {
                if (disposed) return;
                if (installerLang === 'zh' || installerLang === 'tw' || installerLang === 'en') {
                  setLanguage(installerLang);
                } else {
                  applySystemLanguage();
                }
             })
             .catch(() => {
                if (!disposed) applySystemLanguage();
             });
        }
      })
      .catch((err) => {
        console.error(err);
        if (!disposed) {
          setSettingsLoadError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      disposed = true;
    };
  }, [setHotkey, setCompactMode, setLanguage]);

  return settings;
};
