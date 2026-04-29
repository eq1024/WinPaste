import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, SetStateAction } from "react";
import type { DefaultAppsMap, InstalledAppOption } from "../../features/app/types";

interface UseAppBootstrapOptions {
  setDataPath: Dispatch<SetStateAction<string>>;
  setInstalledApps: Dispatch<SetStateAction<InstalledAppOption[]>>;
  setAutoStart: Dispatch<SetStateAction<boolean>>;
  setWinClipboardDisabled: Dispatch<SetStateAction<boolean>>;
  setDefaultApps: Dispatch<SetStateAction<DefaultAppsMap>>;
}

export const useAppBootstrap = ({
  setDataPath,
  setInstalledApps,
  setAutoStart,
  setWinClipboardDisabled,
  setDefaultApps
}: UseAppBootstrapOptions) => {
  useEffect(() => {
    let disposed = false;

    invoke<string>("get_data_path").then((path) => {
      if (!disposed) setDataPath(path);
    }).catch(console.error);

    invoke<InstalledAppOption[]>("scan_installed_apps").then((apps) => {
      if (!disposed) setInstalledApps(apps);
    }).catch(console.error);

    invoke<boolean>("is_autostart_enabled").then((enabled) => {
      if (!disposed) setAutoStart(enabled);
    }).catch(console.error);

    invoke<boolean>("get_windows_clipboard_history").then((enabled) => {
      if (!disposed) setWinClipboardDisabled(!enabled);
    }).catch(console.error);

    const types = ["text", "image", "video", "code", "url"];
    types.forEach(async (type) => {
      try {
        const appName = await invoke<string>("get_system_default_app", { contentType: type });
        if (!disposed) {
          setDefaultApps(prev => ({ ...prev, [type]: appName }));
        }
      } catch (err) {
        console.error(`Failed to get default app for ${type}`, err);
      }
    });

    return () => {
      disposed = true;
    };
  }, [
    setDataPath,
    setInstalledApps,
    setAutoStart,
    setWinClipboardDisabled,
    setDefaultApps
  ]);
};
