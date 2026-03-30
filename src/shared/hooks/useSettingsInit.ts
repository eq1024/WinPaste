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
    setColorMode
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
        setSettings(res);

        if (res["app.hotkey"]) setHotkey(res["app.hotkey"]);
        if (res["app.compact_mode"]) {
            setCompactMode(res["app.compact_mode"] === 'true');
            try { localStorage.setItem('winpaste_compact_mode', res["app.compact_mode"]); } catch(e) {}
        }
        if (res["app.color_mode"]) {
          setColorMode(res["app.color_mode"] as 'dark' | 'light' | 'system');
        }
        if (res["app.language"]) {
           setLanguage(res["app.language"] as Locale);
        } else {
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
        }
      })
      .catch(console.error);

    return () => {
      disposed = true;
    };
  }, [setHotkey, setCompactMode, setLanguage]);

  return settings;
};
