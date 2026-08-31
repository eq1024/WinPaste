import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ConfirmOption } from "../types";
import { useSettingsStore } from "../store/settingsStore";
interface UseAppActionsProps {
  t: (key: string) => string;
  openConfirm: (opts: {
    title: string;
    message?: string;
    options?: ConfirmOption[];
    onConfirm: (selectedId?: string) => void;
  }) => void;
  closeConfirm: () => void;
  pushToast: (msg: string, duration?: number) => number;
  fetchHistory: (reset?: boolean) => Promise<void>;
}

export const useAppActions = ({
  t,
  openConfirm,
  closeConfirm,
  pushToast,
  fetchHistory
}: UseAppActionsProps) => {

  const clearHistory = () => {
    openConfirm({
      title: t('clear_history_title'),
      options: [
        { id: 'all', label: t('clear_all_entries') },
        { id: 'invalid', label: t('clear_invalid_entries') },
      ],
      onConfirm: async (selectedId?: string) => {
        try {
          if (selectedId === 'invalid') {
            const removed = await invoke<number>("clear_invalid_file_entries");
            await fetchHistory(true);
            pushToast(removed > 0 ? t('invalid_cleared') : t('no_invalid_entries'));
          } else {
            await invoke("clear_clipboard_history");
            await fetchHistory(true);
            pushToast(t('history_cleared'));
          }
        } catch (err) {
          console.error(err);
          pushToast(t('clear_failed'));
        } finally {
          closeConfirm();
        }
      }
    });
  };

  const handleResetSettings = () => {
    openConfirm({
      title: t('reset_settings'),
      message: '',
      onConfirm: async () => {
        try {
          await invoke("reset_settings");
          // Refresh the raw settings snapshot so panels reading app.* keys
          // (e.g. 默认打开程序) don't show stale values if the relaunch
          // below is blocked or fails while the process keeps running.
          try {
            const fresh = await invoke<Record<string, string>>("get_settings");
            useSettingsStore.getState().setAppSettings(fresh);
          } catch (refreshErr) {
            console.error("Failed to refresh settings snapshot after reset:", refreshErr);
          }
          closeConfirm();
          pushToast("Settings reset successfully");
          setTimeout(() => {
            getCurrentWindow().close();
            invoke("relaunch").catch(console.error);
          }, 500);
        } catch (err) {
          console.error("Reset failed:", err);
          pushToast("Failed to reset settings");
          closeConfirm();
        }
      }
    });
  };

  return { clearHistory, handleResetSettings };
};
