import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Dispatch, SetStateAction } from "react";
import type { ClipboardEntry } from "../types";
import { useHistoryStore } from "../store/historyStore";

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
    pasteWithFormat?: boolean,
    isExternal?: boolean,
    filePreviewExists?: boolean
  ) => Promise<void>;
  openContent: (item: ClipboardEntry) => void;
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
  openContent,
  setSearch,
  setShowSearchBox
}: UseKeyboardNavigationOptions) => {
  const selectedIndexRef = useRef(selectedIndex);
  const isKeyboardModeRef = useRef(isKeyboardMode);
  const historyRef = useRef(filteredHistory);
  const showSettingsRef = useRef(showSettings);
  const showTagManagerRef = useRef(showTagManager);
  const editingTagsIdRef = useRef(editingTagsId);
  // 输入法组合期间按下的 Enter 会先被输入法用来上屏候选词，粘贴意图不能丢：
  // 记下来，等 compositionend 之后再执行粘贴（否则必须按两次回车）。
  const pendingImePasteRef = useRef<ClipboardEntry | null>(null);

  useEffect(() => { selectedIndexRef.current = selectedIndex; }, [selectedIndex]);
  useEffect(() => { isKeyboardModeRef.current = isKeyboardMode; }, [isKeyboardMode]);
  useEffect(() => { historyRef.current = filteredHistory; }, [filteredHistory]);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);
  useEffect(() => { showTagManagerRef.current = showTagManager; }, [showTagManager]);
  useEffect(() => { editingTagsIdRef.current = editingTagsId; }, [editingTagsId]);

  // 输入法上屏完成后，补发那次被 IME 吞掉的粘贴。
  useEffect(() => {
    const handleCompositionEnd = (ev: CompositionEvent) => {
      const pending = pendingImePasteRef.current;
      if (!pending) return;
      pendingImePasteRef.current = null;
      // 取消输入（Esc）时 data 为空，不触发粘贴。
      if (!ev.data) return;
      // 等 IME 提交和 React 状态落地后再走粘贴管线。
      setTimeout(() => {
        const latest = historyRef.current.find((item) => item.id === pending.id) ?? pending;
        copyToClipboard(latest.id, latest.content, latest.content_type, false, latest.is_external, latest.file_preview_exists);
      }, 0);
    };
    window.addEventListener("compositionend", handleCompositionEnd);
    return () => window.removeEventListener("compositionend", handleCompositionEnd);
  }, [copyToClipboard]);

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
        } else if (action.startsWith("quick-paste:")) {
          // Allow quick paste even if settings are open
        } else {
          return;
        }
      }

      if (action === "up" || action === "down") {
        const isArrowDown = action === "down";
        
        if (!isKeyboardModeRef.current) {
          setIsKeyboardMode(true);
          isKeyboardModeRef.current = true;
          
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

      if (action === "enter") {
        // 搜索框聚焦时，只有输入法组合期间的 Enter 才放行给 IME；
        // 非组合状态（例如搜索完选好条目后）按 Enter 应该正常粘贴。
        if (
          document.activeElement === searchInputRef.current &&
          useHistoryStore.getState().isComposing
        ) {
          return;
        }
        const item = historyRef.current[selectedIndexRef.current];
        invoke("frontend_log", { msg: `enter(nav-action) idx=${selectedIndexRef.current} len=${historyRef.current.length} item=${item ? item.id : "none"} search="${useHistoryStore.getState().search}"` }).catch(() => {});
        if (item) {
          copyToClipboard(item.id, item.content, item.content_type, false, item.is_external, item.file_preview_exists);
        }
        return;
      }

      if (action.startsWith("quick-paste:")) {
        const idx = parseInt(action.split(":")[1], 10);
        if (!isNaN(idx) && idx >= 0 && idx < historyRef.current.length) {
          const item = historyRef.current[idx];
          if (item) {
            // First select it visually if window is open
            setSelectedIndex(idx);
            selectedIndexRef.current = idx;
            // Then copy & paste
            copyToClipboard(item.id, item.content, item.content_type, false, item.is_external, item.file_preview_exists);
          }
        }
        return;
      }

      if (action === "search-activate") {
        setShowSearchBox(true);
        setTimeout(() => {
          if (searchInputRef.current) {
            searchInputRef.current.focus({ preventScroll: true });
            searchInputRef.current.click();
          }
        }, 250);
        return;
      }

      if (action.startsWith("search:")) {
        // Fallback for any legacy search triggers if needed
        const char = action.split(":")[1];
        setShowSearchBox(true);
        if (char === "backspace") {
           setSearch(prev => prev.slice(0, -1));
        } else if (char === "space") {
           setSearch(prev => prev + " ");
        } else {
           setSearch(prev => prev + char);
        }
        setTimeout(() => {
          if (searchInputRef.current) {
            searchInputRef.current.focus({ preventScroll: true });
            searchInputRef.current.click();
          }
        }, 250);
        return;
      }

      if (action === "escape") {
        invoke("hide_window_cmd").catch(console.error);
        return;
      }
    });

    const handleReset = () => {
      setIsKeyboardMode(false);
      isKeyboardModeRef.current = false;
      setSelectedIndex(0);
      selectedIndexRef.current = 0;
      pendingImePasteRef.current = null;
      // 搜索框有值时保留搜索状态：用户让搜索框失焦是为了查看搜索结果（同时避免
      // tag 面板遮挡），而不是关闭搜索。仅当无搜索内容时才隐藏搜索框。
      const currentSearch = useHistoryStore.getState().search;
      if (currentSearch.trim().length === 0) {
        setShowSearchBox(false);
      }
    };

    const unlistenBlur = listen("tauri://blur", handleReset);
    const unlistenHidden = listen("window-hidden", handleReset);

    return () => {
      unlistenNav.then(fn => fn()).catch(console.error);
      unlistenBlur.then(fn => fn()).catch(console.error);
      unlistenHidden.then(fn => fn()).catch(console.error);
    };
  }, [arrowKeySelection, setIsKeyboardMode, setSelectedIndex, copyToClipboard, setShowSearchBox, setSearch]);

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
      // 注意：keyCode 229 只表示"这个键被输入法处理过"，未组合时也会出现
      // （Windows 中文输入法对回车很常见）。只有确实处于组合状态才为
      // Enter 让路，否则第一次回车会被白白吞掉。
      if (e.isComposing || (e.keyCode === 229 && !isEnter)) {
        if (isArrowUp || isArrowDown) console.log(`[KeyboardNav Debug] Returned early due to IME composition`);
        // 已经用方向键选中条目时，这次 Enter 的意图是粘贴；IME 吃掉的是
        // "上屏"那一下，真正的粘贴推迟到 compositionend 之后补发。
        if (isEnter) {
          invoke("frontend_log", { msg: `enter swallowed by IME guard (composing=${e.isComposing} keyCode=${e.keyCode}) kbd=${isKeyboardModeRef.current} idx=${selectedIndexRef.current} len=${historyRef.current.length}` }).catch(() => {});
        }
        if (isEnter && isKeyboardModeRef.current && activeEl === searchInputRef.current) {
          const selected = historyRef.current[selectedIndexRef.current];
          if (selected) pendingImePasteRef.current = selected;
        }
        return;
      }
      
      // Allow repeat for Arrow keys；Enter 在有选中项时也放行：粘贴链路本身
      // 有同 id 去重，长按不会连发，但某些键盘/输入法会把首次回车标成 repeat。
      if (e.repeat && !isArrowUp && !isArrowDown && !isEnter) return;

      if (isArrowUp || isArrowDown) {
        console.log(`[KeyboardNav Debug] States -> isInputFocused: ${isInputFocused}, isSearchInputFocused: ${isSearchInputFocused}, isEditingTags: ${isEditingTags}, showSettings: ${showSettingsRef.current}, showTagManager: ${showTagManagerRef.current}`);
      }

      // 2. Special modes handling (Settings, Tag Manager)
      if (showSettingsRef.current || showTagManagerRef.current) {
        if (isArrowUp || isArrowDown) console.log(`[KeyboardNav Debug] Returned early due to showSettings or showTagManager`);
        if (isEnter) {
          invoke("frontend_log", { msg: `enter swallowed by overlay guard (settings=${showSettingsRef.current} tagMgr=${showTagManagerRef.current})` }).catch(() => {});
        }
        if (isEscape && !e.isComposing && e.keyCode !== 229) {
          invoke("hide_window_cmd").catch(console.error);
        }
        return;
      }

      // 3. Tag editing mode handling
      if (isEditingTags) {
        if (isArrowUp || isArrowDown) console.log(`[KeyboardNav Debug] Returned early due to isEditingTags`);
        if (isEnter) {
          invoke("frontend_log", { msg: `enter swallowed by tag-editing guard (editingTags=${editingTagsIdRef.current})` }).catch(() => {});
        }
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
        if (e.isComposing) return;
        
        // 搜索框聚焦时，非输入法组合状态的 Enter 仍可粘贴；
        // 其他输入框聚焦仍不粘贴，避免误触发。
        if (isInputFocused && !isSearchInputFocused) {
          invoke("frontend_log", { msg: `enter swallowed by input-focus guard (active=${activeEl?.tagName ?? "null"})` }).catch(() => {});
          return;
        }
        if (isSearchInputFocused) e.preventDefault();
        
        const item = historyRef.current[selectedIndexRef.current];
        if (item) {
          if (item.is_external && item.file_preview_exists === false) {
             openContent(item); // This will trigger the error toast
             return;
          }
          copyToClipboard(item.id, item.content, item.content_type, false, item.is_external, item.file_preview_exists);
        }
        return;
      }

      // 8. Ctrl+F or / to start search
      const isCtrlF = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f';
      const isSlash = !e.ctrlKey && !e.metaKey && !e.altKey && e.key === '/';

      if (isCtrlF || isSlash) {
        // Only steal focus if not already in an input
        if (!isInputFocused && !showSettingsRef.current && !showTagManagerRef.current && !isEditingTags) {
          e.preventDefault();
          e.stopPropagation();
          setShowSearchBox(true);
          setTimeout(() => {
            if (searchInputRef.current) {
              searchInputRef.current.focus({ preventScroll: true });
              searchInputRef.current.click();
            }
          }, 250);
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
    openContent,
    searchInputRef,
    showSettings,
    showTagManager,
    editingTagsId,
    setSearch
  ]);
};
