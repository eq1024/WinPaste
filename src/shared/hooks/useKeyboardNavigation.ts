import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Dispatch, SetStateAction } from "react";
import type { ClipboardEntry } from "../types";

interface UseKeyboardNavigationOptions {
  filteredHistory: ClipboardEntry[];
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  isKeyboardMode: boolean;
  setIsKeyboardMode: Dispatch<SetStateAction<boolean>>;
  showSettings: boolean;
  showTagManager: boolean;
  editingTagsId: number | null;
  arrowKeySelection: boolean;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  copyToClipboard: (
    id: number,
    content: string,
    contentType: string,
    pasteWithFormat?: boolean
  ) => Promise<void>;
  setSearch: Dispatch<SetStateAction<string>>;
  setShowSearchBox: (show: boolean) => void;
}

export const useKeyboardNavigation = ({
  filteredHistory,
  selectedIndex,
  setSelectedIndex,
  isKeyboardMode,
  setIsKeyboardMode,
  showSettings,
  showTagManager,
  editingTagsId,
  arrowKeySelection,
  searchInputRef,
  copyToClipboard,
  setSearch,
  setShowSearchBox
}: UseKeyboardNavigationOptions) => {
  const selectedIndexRef = useRef(selectedIndex);
  const isKeyboardModeRef = useRef(isKeyboardMode);
  const historyRef = useRef(filteredHistory);
  const showSettingsRef = useRef(showSettings);
  const showTagManagerRef = useRef(showTagManager);
  const editingTagsIdRef = useRef(editingTagsId);

  useEffect(() => { selectedIndexRef.current = selectedIndex; }, [selectedIndex]);
  useEffect(() => { isKeyboardModeRef.current = isKeyboardMode; }, [isKeyboardMode]);
  useEffect(() => { historyRef.current = filteredHistory; }, [filteredHistory]);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);
  useEffect(() => { showTagManagerRef.current = showTagManager; }, [showTagManager]);
  useEffect(() => { editingTagsIdRef.current = editingTagsId; }, [editingTagsId]);

  useEffect(() => {
    // 监听 Rust 全局键盘钩子发送的导航事件
    const unlistenNav = listen<string>("navigation-action", (e) => {
      const action = e.payload;

      // 如果有任何浮层/设置处于打开状态，只处理 escape 以关闭窗口
      if (
        showSettingsRef.current ||
        showTagManagerRef.current ||
        editingTagsIdRef.current !== null
      ) {
        if (action === "escape") {
          invoke("hide_window_cmd").catch(console.error);
        }
        return;
      }

      if (action === "up" || action === "down") {
        if (!isKeyboardModeRef.current) {
          setIsKeyboardMode(true);
          isKeyboardModeRef.current = true;
          const idx = action === "down" ? 0 : historyRef.current.length - 1;
          setSelectedIndex(idx);
          selectedIndexRef.current = idx;
          return;
        }

        const dir = action === "down" ? 1 : -1;
        const nextIndex = Math.max(
          0,
          Math.min(historyRef.current.length - 1, selectedIndexRef.current + dir)
        );
        setSelectedIndex(nextIndex);
        selectedIndexRef.current = nextIndex;
        return;
      }

      if (action === "enter") {
        const item = historyRef.current[selectedIndexRef.current];
        if (item) {
          copyToClipboard(item.id, item.content, item.content_type, false);
        }
        return;
      }

      if (action === "escape") {
        invoke("hide_window_cmd").catch(console.error);
        return;
      }
    });

    const unlistenPinned = listen("window-pinned-changed", () => {
      invoke("focus_clipboard_window").catch(console.error);
    });

    const unlistenBlur = listen("tauri://blur", () => {
      setIsKeyboardMode(false);
      isKeyboardModeRef.current = false;
      setSelectedIndex(0);
      selectedIndexRef.current = 0;
    });

    return () => {
      unlistenNav.then(fn => fn()).catch(console.error);
      unlistenPinned.then(fn => fn()).catch(console.error);
      unlistenBlur.then(fn => fn()).catch(console.error);
    };
  }, [arrowKeySelection, setIsKeyboardMode, setSelectedIndex, copyToClipboard]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInputFocused = activeEl?.tagName === "INPUT" || activeEl?.tagName === "TEXTAREA";
      const isSearchInputFocused = activeEl === searchInputRef.current;
      const isEditingTags = editingTagsIdRef.current !== null;

      // 1. Basic bypass conditions
      const isEscape = e.key === "Escape" || e.keyCode === 27;
      const isEnter = e.key === "Enter" || e.keyCode === 13;
      const isArrowUp = e.key === "ArrowUp" || e.key === "Up" || e.keyCode === 38;
      const isArrowDown = e.key === "ArrowDown" || e.key === "Down" || e.keyCode === 40;
      const isTab = e.key === "Tab" || e.keyCode === 9;
      
      // Allow repeat for Arrow keys
      if (e.repeat && !isArrowUp && !isArrowDown) return;

      // 2. Special modes handling (Settings, Tag Manager)
      if (showSettingsRef.current || showTagManagerRef.current) {
        if (isEscape) {
          invoke("hide_window_cmd").catch(console.error);
        }
        return;
      }

      // 3. Tag editing mode handling
      // In tag editing mode, we should NOT intercept keys that the input needs
      if (isEditingTags) {
        // Only global action here is Escape to potentially hide window,
        // but wait: we want Escape to close the tag editor first.
        // So we return here and let the component handle Escape.
        if (isEscape) return; 
        
        // If focus is not in the input (e.g. on a tag chip delete button),
        // we might still want to ignore most global actions.
        if (isInputFocused && !isSearchInputFocused) return;
        
        // However, if we are editing tags but NOT focused on the input,
        // we might still want to prevent list navigation conflicts.
        if (isArrowDown || isArrowUp || isEnter) return;
      }

      // 4. Global Escape (when no special mode is active)
      if (isEscape) {
        invoke("hide_window_cmd").catch(console.error);
        return;
      }

      // 5. Tab to focus search
      if (isTab && !isSearchInputFocused) {
        // If we are already in another input (like tag input), don't steal Tab
        if (isInputFocused) return;
        
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      // 6. Navigation (Up/Down)
      if (isArrowDown || isArrowUp) {
        // Don't navigate if focused on some other input
        if (isInputFocused && !isSearchInputFocused) return;
        
        e.preventDefault();
        
        if (!isKeyboardModeRef.current) {
          setIsKeyboardMode(true);
          isKeyboardModeRef.current = true;
          const idx = isArrowDown ? 0 : historyRef.current.length - 1;
          setSelectedIndex(idx);
          selectedIndexRef.current = idx;
          return;
        }

        const dir = isArrowDown ? 1 : -1;
        const nextIndex = Math.max(
          0,
          Math.min(historyRef.current.length - 1, selectedIndexRef.current + dir)
        );
        setSelectedIndex(nextIndex);
        selectedIndexRef.current = nextIndex;
        return;
      }

      // 7. Enter to copy
      if (isEnter) {
        // Don't copy if focused on some other input
        if (isInputFocused && !isSearchInputFocused) return;
        
        const item = historyRef.current[selectedIndexRef.current];
        if (item) {
          copyToClipboard(item.id, item.content, item.content_type, false);
        }
        return;
      }

      // 8. Alphanumeric to start search
      const isProcess = e.key === 'Process' || e.key === 'Unidentified' || e.keyCode === 229 || e.isComposing;
      const isAlphanumeric = /^[a-zA-Z0-9]$/.test(e.key);
      const isChinesePunctuation = /^[，。！？；：“”‘’【】《》（）—…、·]$/.test(e.key);

      if (isAlphanumeric || isChinesePunctuation || isProcess) {
        // Only steal focus if not already in an input
        if (!isInputFocused && !showSettingsRef.current && !showTagManagerRef.current && !isEditingTags) {
          setShowSearchBox(true);
          searchInputRef.current?.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    arrowKeySelection,
    setIsKeyboardMode,
    setSelectedIndex,
    copyToClipboard,
    searchInputRef,
    showSettings,
    showTagManager,
    editingTagsId,
    setSearch
  ]);
};
