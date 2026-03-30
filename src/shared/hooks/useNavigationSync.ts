import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface UseNavigationSyncOptions {
  showSettings: boolean;
  showTagManager: boolean;
}

export const useNavigationSync = ({
  showSettings,
  showTagManager
}: UseNavigationSyncOptions) => {
  const isNavigatingRef = useRef(false);

  useEffect(() => {
    isNavigatingRef.current = showSettings || showTagManager;
  }, [showSettings, showTagManager]);

  useEffect(() => {
    const isNavMode = showSettings || showTagManager;
    invoke("set_navigation_mode", { active: isNavMode }).catch(console.error);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isNavigatingRef.current) {
        e.preventDefault();
        e.stopPropagation();
        invoke("toggle_window_cmd").catch(console.error);
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [showSettings, showTagManager]);
};
