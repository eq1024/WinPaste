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

    const unlistenBlur = listen("tauri://blur", () => {
      setIsKeyboardMode(false);
      isKeyboardModeRef.current = false;
      setSelectedIndex(0);
      selectedIndexRef.current = 0;
    });

    return () => {
      unlistenNav.then(fn => fn()).catch(console.error);
      unlistenBlur.then(fn => fn()).catch(console.error);
    };
  }, [arrowKeySelection, setIsKeyboardMode, setSelectedIndex, copyToClipboard]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInputFocused = activeEl?.tagName === "INPUT" || activeEl?.tagName === "TEXTAREA" || activeEl?.tagName === "SELECT";
      const isSearchInputFocused = activeEl === searchInputRef.current;
      const isEditingTags = editingTagsIdRef.current !== null;

      // 1. Basic bypass conditions
      const isEscape = e.key === "Escape" || e.keyCode === 27;
      const isEnter = e.key === "Enter" || e.keyCode === 13;
      const isArrowUp = e.key === "ArrowUp" || e.key === "Up" || e.keyCode === 38;
      const isArrowDown = e.key === "ArrowDown" || e.key === "Down" || e.keyCode === 40;
      const isTab = e.key === "Tab" || e.keyCode === 9;
      
      if (isArrowUp || isArrowDown) {
        console.log(`[KeyboardNav Debug] Key pressed: ${e.key}, isComposing: ${e.isComposing}, keyCode: ${e.keyCode}`);
      }

      // 0. IMPORTANT: Never intercept keys while the user is using an IME (e.g. typing Chinese)
      if (e.isComposing || e.keyCode === 229) {
        if (isArrowUp || isArrowDown) console.log(`[KeyboardNav Debug] Returned early due to IME composition`);
        return;
      }
      
      // Allow repeat for Arrow keys
      if (e.repeat && !isArrowUp && !isArrowDown) return;

      if (isArrowUp || isArrowDown) {
        console.log(`[KeyboardNav Debug] States -> isInputFocused: ${isInputFocused}, isSearchInputFocused: ${isSearchInputFocused}, isEditingTags: ${isEditingTags}, showSettings: ${showSettingsRef.current}, showTagManager: ${showTagManagerRef.current}`);
      }

      // 2. Special modes handling (Settings, Tag Manager)
      if (showSettingsRef.current || showTagManagerRef.current) {
        if (isArrowUp || isArrowDown) console.log(`[KeyboardNav Debug] Returned early due to showSettings or showTagManager`);
        if (isEscape && !e.isComposing && e.keyCode !== 229) {
          invoke("hide_window_cmd").catch(console.error);
        }
        return;
      }

      // 3. Tag editing mode handling
      if (isEditingTags) {
        if (isArrowUp || isArrowDown) console.log(`[KeyboardNav Debug] Returned early due to isEditingTags`);
        if (isEscape) return;
        if (isInputFocused && !isSearchInputFocused) return;
        if (isArrowDown || isArrowUp || isEnter) return;
      }

      // 4. Global Escape
      if (isEscape) {
        invoke("hide_window_cmd").catch(console.error);
        return;
      }

      // 5. Tab
      if (isTab && !isSearchInputFocused) {
        if (isInputFocused) return;
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      // 6. Navigation (Up/Down)
      if (isArrowDown || isArrowUp) {
        if (isInputFocused && !isSearchInputFocused) {
           console.log(`[KeyboardNav Debug] Returned early: isInputFocused && !isSearchInputFocused`);
           return;
        }
        
        e.preventDefault();
        console.log(`[KeyboardNav Debug] Processing navigation. isKeyboardModeRef.current: ${isKeyboardModeRef.current}, currentIdx: ${selectedIndexRef.current}`);
        
        if (!isKeyboardModeRef.current) {
          setIsKeyboardMode(true);
          isKeyboardModeRef.current = true;
          // Use current selection if valid, otherwise jump to start/end
          const currentIdx = selectedIndexRef.current;
          const isValidIdx = currentIdx >= 0 && currentIdx < historyRef.current.length;
          
          let nextIdx = 0;
          if (isValidIdx) {
              nextIdx = isArrowDown
                  ? Math.min(historyRef.current.length - 1, currentIdx + 1)
                  : Math.max(0, currentIdx - 1);
          } else {
              nextIdx = isArrowDown ? 0 : historyRef.current.length - 1;
          }
          
          setSelectedIndex(nextIdx);
          selectedIndexRef.current = nextIdx;
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
        if (e.isComposing || e.keyCode === 229) return;
        
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
