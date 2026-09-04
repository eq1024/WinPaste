import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ClipboardEntry } from "../types";
import type { VirtualClipboardListHandle } from "../../features/clipboard/types";
import { StickyManager } from "../../features/sticky/StickyManager";

interface UseClipboardActionsOptions {
  t: (key: string) => string;
  pushToast: (msg: string, duration?: number) => number;
  deleteAfterPaste: boolean;
  moveToTopAfterPaste: boolean;
  setSearch: (val: string) => void;
  setHistory: Dispatch<SetStateAction<ClipboardEntry[]>>;
  virtualListRef: RefObject<VirtualClipboardListHandle | null>;
  onStickyCreated?: () => void;
}

export const useClipboardActions = ({
  t,
  pushToast,
  deleteAfterPaste,
  moveToTopAfterPaste,
  setSearch,
  setHistory,
  virtualListRef,
  onStickyCreated
}: UseClipboardActionsOptions) => {
  const copyToClipboard = useCallback(
    async (id: number, content: string, contentType: string, pasteWithFormat = false, isExternal?: boolean, filePreviewExists?: boolean) => {
      if (isExternal && filePreviewExists === false) {
          pushToast(contentType === "image" ? t("image_deleted") : t("file_deleted"), 3000);
          return;
      }
      try {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }

        await invoke("copy_to_clipboard", {
          content,
          contentType,
          paste: true,
          id: id,
          deleteAfterUse: deleteAfterPaste,
          pasteWithFormat,
          moveToTop: moveToTopAfterPaste
        });

        if (moveToTopAfterPaste && !deleteAfterPaste) {
          const now = Date.now();
          setHistory((prev) =>
            prev.map((item) =>
              item.id === id ? { ...item, timestamp: now } : item
            )
          );
        }

        setSearch("");
      } catch (err) {
        const errStr = err?.toString() || "";
        if (errStr.includes("File not found") || errStr.includes("os error 2") || errStr.includes("系统找不到指定的文件") || errStr.includes("The system cannot find the file specified")) {
            pushToast(contentType === "image" ? t("image_deleted") : t("file_deleted"), 3000);
            setHistory(prev => prev.map(i => i.id === id ? { ...i, file_preview_exists: false } : i));
        } else {
            const errorMsg = t("copy_failed") + errStr;
            pushToast(errorMsg, 3000);
        }
      }
    },
    [deleteAfterPaste, moveToTopAfterPaste, pushToast, setHistory, setSearch, t]
  );

  const openContent = useCallback(
    async (item: ClipboardEntry) => {
      if (item.is_external && item.file_preview_exists === false) {
          pushToast(item.content_type === "image" ? t("image_deleted") : t("file_deleted"), 3000);
          return;
      }
      try {
        await invoke("open_content", {
          id: item.id,
          content: item.content,
          contentType: item.content_type
        });
        invoke("hide_window_cmd").catch(console.error);
      } catch (err) {
        const errStr = err?.toString() || "";
        if (errStr.includes("File not found") || errStr.includes("os error 2") || errStr.includes("系统找不到指定的文件") || errStr.includes("The system cannot find the file specified")) {
            pushToast(item.content_type === "image" ? t("image_deleted") : t("file_deleted"), 3000);
            setHistory(prev => prev.map(i => i.id === item.id ? { ...i, file_preview_exists: false } : i));
        } else {
            const errorMsg = t("open_failed") + errStr;
            pushToast(errorMsg, 3000);
        }
      }
    },
    [pushToast, t, setHistory]
  );

  const deleteEntry = useCallback(
    async (e: ReactMouseEvent, id: number) => {
      e.stopPropagation();
      try {
        await invoke("delete_clipboard_entry", { id });
        setHistory((prev) => prev.filter((item) => item.id !== id));
      } catch (err) {
        const errorMsg = "删除失败: " + (err?.toString() || "");
        pushToast(errorMsg, 3000);
      }
    },
    [pushToast, setHistory]
  );

  const togglePin = useCallback(
    async (e: ReactMouseEvent, id: number, currentPinned: boolean) => {
      e.stopPropagation();
      try {
        await invoke("toggle_clipboard_pin", { id, isPinned: !currentPinned });
        setHistory((prev) =>
          prev
            .map((item) =>
              item.id === id ? { ...item, is_pinned: !currentPinned } : item
            )
            .sort((a, b) => {
              if (a.is_pinned === b.is_pinned) return b.timestamp - a.timestamp;
              return a.is_pinned ? -1 : 1;
            })
        );
      } catch (err) {
        const errorMsg =
          (currentPinned ? "取消固定失败" : "固定失败") + ": " + (err?.toString() || "");
        pushToast(errorMsg, 3000);
      }
    },
    [pushToast, setHistory]
  );

  const createSticky = useCallback(
    async (item: ClipboardEntry) => {
      let content = item.content;
      if (!content) {
        // List payloads carry only thumbnails for base64 images.
        content = await invoke<string>("get_clipboard_content", { id: item.id }).catch(() => "");
      }
      await StickyManager.createSticky(content, item.content_type);
      onStickyCreated?.();
    },
    [onStickyCreated]
  );

  const handleUpdateTags = useCallback(
    async (id: number, newTags: string[]) => {
      try {
        const newId = await invoke<number>("update_tags", { id, tags: newTags });
        setHistory((prev) =>
          prev.map((item) => (item.id === id ? { ...item, id: newId, tags: newTags } : item))
        );

        setTimeout(() => {
          if (virtualListRef.current) {
            virtualListRef.current.resetAfterIndex(0);
          }
        }, 0);
      } catch (err) {
        console.error("更新标签失败", err);
      }
    },
    [setHistory, virtualListRef]
  );

  return {
    copyToClipboard,
    openContent,
    deleteEntry,
    togglePin,
    createSticky,
    handleUpdateTags
  };
};


