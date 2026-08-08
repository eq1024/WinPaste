import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
interface UseAppActionsProps {
  t: (key: string) => string;
  openConfirm: (opts: { title: string; message: string; onConfirm: () => void }) => void;
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
      message: t('clear_history_confirm'),
      onConfirm: async () => {
        try {
          await invoke("clear_clipboard_history");
          await fetchHistory(true);
          pushToast(t('history_cleared'));
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
