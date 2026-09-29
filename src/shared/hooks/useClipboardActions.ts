import { useCallback, useRef } from "react";
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
  // 粘贴管线（隐藏窗口→焦点归还→写剪贴板→发按键）需要数百毫秒。期间并发
  // 再入会各自 SendInput 一遍 Ctrl+V，阻塞解除后表现为"一口气粘贴很多遍"。
  // 策略：
  //  - 同一条目的重复触发（连点/连按 Enter）→ 直接忽略（去重）
  //  - 不同条目（Ctrl+Shift+数字 连续快贴多个条目）→ 排队串行执行，不丢弃
  //  - Rust 侧另有 paste_in_progress 原子互斥作最终兜底
  const pasteBusyRef = useRef(false);
  const pasteRunningIdRef = useRef<number | null>(null);
  const pasteQueueRef = useRef<Array<{
    id: number; content: string; contentType: string;
    pasteWithFormat: boolean; isExternal?: boolean; filePreviewExists?: boolean;
  }>>([]);
  const MAX_PASTE_QUEUE = 5;

  const runPaste = useCallback(
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
        if (errStr.includes("paste_in_progress")) {
            // Rust 侧互斥拒绝（前端锁万一被绕过时的兜底），静默忽略
            return;
        }
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

  const copyToClipboard = useCallback(
    async (id: number, content: string, contentType: string, pasteWithFormat = false, isExternal?: boolean, filePreviewExists?: boolean) => {
      if (pasteBusyRef.current) {
        // 管线进行中：同条目忽略（连点去重），不同条目入队（连续快贴）
        if (id !== pasteRunningIdRef.current
          && !pasteQueueRef.current.some((p) => p.id === id)
          && pasteQueueRef.current.length < MAX_PASTE_QUEUE) {
          pasteQueueRef.current.push({ id, content, contentType, pasteWithFormat, isExternal, filePreviewExists });
        }
        return;
      }
      pasteBusyRef.current = true;
      try {
        let current: { id: number; content: string; contentType: string; pasteWithFormat: boolean; isExternal?: boolean; filePreviewExists?: boolean } =
          { id, content, contentType, pasteWithFormat, isExternal, filePreviewExists };
        for (;;) {
          pasteRunningIdRef.current = current.id;
          await runPaste(current.id, current.content, current.contentType, current.pasteWithFormat, current.isExternal, current.filePreviewExists);
          const next = pasteQueueRef.current.shift();
          if (!next) break;
          current = next;
        }
      } finally {
        pasteBusyRef.current = false;
        pasteRunningIdRef.current = null;
      }
    },
    [runPaste]
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


