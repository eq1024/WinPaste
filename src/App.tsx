import { useEffect, useMemo, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ToastContainer from "./shared/components/ToastContainer";
import ConfirmDialog from "./shared/components/ConfirmDialog";

import { translations } from "./locales";
import AppHeader from "./features/app/components/AppHeader";
import AppMainContent from "./features/app/components/AppMainContent";
import { useSettingsStore } from "./shared/store/settingsStore";
import { useHistoryStore } from "./shared/store/historyStore";
import { useUIStore } from "./shared/store/uiStore";
import { useSettingsPanelProps } from "./features/settings/hooks/useSettingsPanelProps";
import { useDebounce } from "./shared/hooks/useDebounce";
import { useHistoryFetch } from "./shared/hooks/useHistoryFetch";
import { useHotkeyConfig } from "./shared/hooks/useHotkeyConfig";
import { useInputFocus } from "./shared/hooks/useInputFocus";
import { useSearchScroll } from "./shared/hooks/useSearchScroll";
import { useSettingsApply } from "./shared/hooks/useSettingsApply";
import { useSettingsInit } from "./shared/hooks/useSettingsInit";
import { useSettingsPostInit } from "./shared/hooks/useSettingsPostInit";
import { useSettingsSync } from "./shared/hooks/useSettingsSync";
import { useClipboardEvents } from "./shared/hooks/useClipboardEvents";
import { useClipboardActions } from "./shared/hooks/useClipboardActions";
import { useSoundEffects } from "./shared/hooks/useSoundEffects";
import { useWindowPinnedListener } from "./shared/hooks/useWindowPinnedListener";
import { useToastListener } from "./shared/hooks/useToastListener";
import { useAppBootstrap } from "./shared/hooks/useAppBootstrap";
import { useAppActions } from "./shared/hooks/useAppActions";
import { useNavigationSync } from "./shared/hooks/useNavigationSync";
import { useContextMenuBlock } from "./shared/hooks/useContextMenuBlock";
import { useSettingsPanelReset } from "./shared/hooks/useSettingsPanelReset";
import { useTagManagerRefresh } from "./shared/hooks/useTagManagerRefresh";
import { matchesHotkey } from "./shared/hooks/useHotkeyMatching";
import { usePinnedSort } from "./shared/hooks/usePinnedSort";
import { useFilteredHistory } from "./shared/hooks/useFilteredHistory";
import { useKeyboardNavigation } from "./shared/hooks/useKeyboardNavigation";
import { useListSelectionReset } from "./shared/hooks/useListSelectionReset";
import { useSearchFetchTrigger } from "./shared/hooks/useSearchFetchTrigger";
import { useScrollToSelection } from "./shared/hooks/useScrollToSelection";
import { useClipboardItemRenderer } from "./shared/hooks/useClipboardItemRenderer";
import { useOverlays } from "./shared/hooks/useOverlays";
import { compactPreviewController } from "./features/clipboard/lib/compactPreviewController";
import type { ClipboardEntry } from "./shared/types";
import type { VirtualClipboardListHandle } from "./features/clipboard/types";

const insertHistoryItem = (list: ClipboardEntry[], item: ClipboardEntry) => {
  const next = list.slice();

  // Try to replace if it exists
  const existingIndex = next.findIndex(i => i.id === item.id);
  if (existingIndex >= 0) {
      next[existingIndex] = item;
      return next.sort((a, b) => {
          if (a.is_pinned === b.is_pinned) {
            if (a.is_pinned) {
              return (b.pinned_order || 0) - (a.pinned_order || 0);
            }
            return b.timestamp - a.timestamp;
          }
          return a.is_pinned ? -1 : 1;
      });
  }

  const isPinned = !!item.is_pinned;
  let insertIndex = 0;

  if (isPinned) {
    while (insertIndex < next.length) {
      const current = next[insertIndex];
      if (!current.is_pinned) break;
      if (current.timestamp < item.timestamp) break;
      insertIndex++;
    }
  } else {
    while (insertIndex < next.length && next[insertIndex].is_pinned) {
      insertIndex++;
    }
    while (insertIndex < next.length) {
      const current = next[insertIndex];
      if (current.is_pinned) {
        insertIndex++;
        continue;
      }
      if (current.timestamp < item.timestamp) break;
      insertIndex++;
    }
  }

  next.splice(insertIndex, 0, item);
  return next;
};

const App = () => {
  const settingsState = useSettingsStore();
  const historyState = useHistoryStore();
  const uiState = useUIStore();

  const {
    language,
    compactMode,
    vibrancyEnabled,
    showAppBorder,
    clipboardItemFontSize,
    clipboardTagFontSize,
    setAutoStart,
    setAutoStartAdmin,
    stickyEnabled,
    arrowKeySelection,
    soundEnabled,
    soundVolume,
    pasteSoundEnabled,
    deduplicate,
    persistent,
    persistentLimitEnabled,
    persistentLimit,
    deleteAfterPaste,
    moveToTopAfterPaste,
    captureFiles,
    captureRichText,
    hotkey,
    setHotkey,
    sequentialHotkey,
    setSequentialHotkey,
    richPasteHotkey,
    setRichPasteHotkey,
    searchHotkey,
    setSearchHotkey,
    setDataPath,
    setInstalledApps,
    setDefaultApps,
    setAppSettings,
    setWinClipboardDisabled,
    settingsLoaded,
    settingsLoadError,
    sequentialMode,
    colorMode,
  } = settingsState;

  const {
    history,
    setHistory,
    search,
    setSearch,
    isComposing,
    setSearchIsFocused,
    showTagFilter,
    setShowTagFilter,
    tagInput,
    setTagInput,
    editingTagsId,
    setEditingTagsId,
    setRevealedIds,
    selectedIndex,
    setSelectedIndex,
    isKeyboardMode,
    setIsKeyboardMode,
    typeFilter,
  } = historyState;

  const {
    showSettings,
    setShowSettings,
    showTagManager,
    setShowTagManager,
    tagManagerEnabled,
    setCollapsedGroups,
    setIsWindowPinned,
    showSearchBox,
    setShowSearchBox,
    scrollTopButtonEnabled,
    isRecording,
    setIsRecording,
    isRecordingSequential,
    setIsRecordingSequential,
    isRecordingRich,
    setIsRecordingRich,
    isRecordingSearch,
    setIsRecordingSearch,
  } = uiState;

  // Adapters for legacy hooks that expect React.Dispatch<React.SetStateAction<T>>
  const setHistoryAdapter = useCallback((v: any) => setHistory(v), [setHistory]) as any;
  const setCollapsedGroupsAdapter = useCallback((v: any) => setCollapsedGroups(v), [setCollapsedGroups]) as any;
  const setDefaultAppsAdapter = useCallback((v: any) => setDefaultApps(v), [setDefaultApps]) as any;
  const setRevealedIdsAdapter = useCallback((v: any) => setRevealedIds(v), [setRevealedIds]) as any;
  const setSelectedIndexAdapter = useCallback((v: any) => setSelectedIndex(v), [setSelectedIndex]) as any;

  const effectiveShowTagManager = showTagManager && tagManagerEnabled;

  const debouncedSearch = useDebounce(search, 400);
  const searchInputRef = useInputFocus<HTMLInputElement>();
  const virtualListRef = useRef<VirtualClipboardListHandle | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  
  const { fetchHistory, loadMoreHistory } = useHistoryFetch({
    debouncedSearch
  });

  const t = useCallback((key: string) => {
    const k = key as keyof typeof translations['zh'];
    return (translations[language] as any)[k] || (translations['en'] as any)[k] || key;
  }, [language]);

  const { handleListScroll: handleSearchScroll, handleMainWheel } = useSearchScroll({
    showSearchBox,
    setShowSearchBox: setShowSearchBox as any,
    search,
    showSettings,
    showTagManager: effectiveShowTagManager,
    appSettings: settingsState.appSettings
  });

  const showScrollTopVisible = showScrollTop && scrollTopButtonEnabled;

  const handleListScroll = useCallback((offset: number) => {
    handleSearchScroll(offset);
    setShowScrollTop(offset > 200);
    void compactPreviewController.hide();
  }, [handleSearchScroll]);

  const handleScrollTop = useCallback(() => {
    if (virtualListRef.current?.scrollToTop) {
      virtualListRef.current.scrollToTop();
      return;
    }
    virtualListRef.current?.scrollToItem(0);
  }, []);

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev: Record<string, boolean>) => ({
      ...prev,
      [group]: !prev[group],
    }));
  };

  const hotkeyParts = useMemo(
    () => (hotkey || t('not_set')).split('+'),
    [hotkey, t]
  );

  const [dbTags, setDbTags] = useState<string[]>([]);
  const [stickyEntries, setStickyEntries] = useState<any[]>([]);

  const fetchStickies = useCallback(async () => {
    try {
      const entries = await invoke<any[]>("get_all_stickies");
      setStickyEntries(entries || []);
    } catch (_) {}
  }, []);

  useEffect(() => {
    let unlisteners: (() => void)[] = [];
    const setupListeners = async () => {
      const fetchTags = () => {
        invoke<Record<string, number>>('get_all_tags_info')
          .then(tagMap => {
            setDbTags(Object.keys(tagMap));
          }).catch(console.error);
      };
      
      fetchTags();
      
      try {
        unlisteners.push(await listen('clipboard-changed', fetchTags));
        unlisteners.push(await listen('clipboard-updated', fetchTags));
        unlisteners.push(await listen('clipboard-removed', fetchTags));
      } catch (e) {
        console.error("Failed to setup tag listeners", e);
      }
    };
    setupListeners();
    return () => unlisteners.forEach(f => f());
  }, []);

  const allTags = useMemo(() => {
    if (!effectiveShowTagManager && !showTagFilter) return [];
    const set = new Set<string>(dbTags);
    history.forEach(item => {
      (item.tags || []).forEach(tag => set.add(tag));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [history, effectiveShowTagManager, showTagFilter, dbTags]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (isRecording || isRecordingSequential || isRecordingRich || isRecordingSearch) return;
      if (!hotkey || hotkey === t('not_set')) return;

      const activeEl = document.activeElement as HTMLElement | null;
      const isEditable = !!activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable
      );

      if (matchesHotkey(event, hotkey)) {
        event.preventDefault();
        invoke("toggle_window_cmd").catch(console.error);
        return;
      }

      if (!isEditable && hotkey.toUpperCase().includes('WIN') && matchesHotkey(event, hotkey, { ignoreWin: true })) {
        event.preventDefault();
        invoke("toggle_window_cmd").catch(console.error);
      }
    };

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  }, [hotkey, isRecording, isRecordingSequential, isRecordingRich, isRecordingSearch, t]);

  const { toasts, pushToast, confirmDialog, openConfirm, closeConfirm } = useOverlays();

  useSoundEffects({ soundEnabled, soundVolume, pasteSoundEnabled });

  const settings = useSettingsInit();

  useEffect(() => {
    if (settingsLoadError) {
      pushToast(t('settings_load_failed'), 5000);
    }
  }, [settingsLoadError, pushToast, t]);

  useSettingsPostInit({
    settings
  });

  useEffect(() => {
    const unlistenShow = listen("window-shown", () => {
      if (virtualListRef.current?.scrollToTop) {
        virtualListRef.current.scrollToTop();
      } else {
        virtualListRef.current?.scrollToItem(0);
      }
      setSelectedIndexAdapter(0);
      setIsKeyboardMode(false);
      // 通知所有可见条目重新执行源文件失效检测
      // （IntersectionObserver 只在布局变化时回调，窗口显示本身不会触发它）
      useUIStore.getState().bumpWindowShowTick();
    });

    const unlistenSearchFocus = listen("focus-search-input", () => {
      setShowSettings(false);
      setShowTagManager(false);
      setShowSearchBox(true);
      setTimeout(() => {
        if (searchInputRef.current) {
          searchInputRef.current.focus({ preventScroll: true });
          searchInputRef.current.click();
        }
      }, 250);
    });

    return () => {
      unlistenShow.then((off) => off());
      unlistenSearchFocus.then((off) => off());
    };
  }, [
    setShowSettings,
    setShowTagManager,
    setShowSearchBox,
    setSearchIsFocused,
    setShowTagFilter,
    searchInputRef,
    setSelectedIndexAdapter,
    setIsKeyboardMode
  ]);

  useEffect(() => {
    if (!tagManagerEnabled && showTagManager) {
      setShowTagManager(false);
    }
  }, [tagManagerEnabled, showTagManager, setShowTagManager]);

  useAppBootstrap({
    setDataPath: setDataPath as any,
    setInstalledApps: setInstalledApps as any,
    setAutoStart: setAutoStart as any,
    setAutoStartAdmin: setAutoStartAdmin as any,
    setWinClipboardDisabled: setWinClipboardDisabled as any,
    setDefaultApps: setDefaultAppsAdapter
  });

  useWindowPinnedListener({
    onPinnedChange: setIsWindowPinned as any
  });

  useContextMenuBlock();

  useSettingsApply({
    showAppBorder,
    compactMode,
    settingsLoaded,
    clipboardItemFontSize,
    clipboardTagFontSize,
    vibrancyEnabled,
    colorMode
  });

  useClipboardEvents({
    onUpdated: (updatedItem) => {
      setHistory((prev: ClipboardEntry[]) => {
        const processedItem = { ...updatedItem };
        // Do not copy old file_preview_exists state, as it may be stale.
        // Rely on the backend's updated status which we now send correctly.
        return insertHistoryItem(prev, processedItem);
      });
    },
    onRemoved: (id) => {
      setHistory((prev: ClipboardEntry[]) => prev.filter(item => item.id !== id));
    },
    onChanged: () => {
      fetchHistory(true);
    }
  });

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Restore persisted sticky windows on startup
  useEffect(() => {
    const restore = async () => {
      try {
        const stickies = await invoke<any[]>("get_all_stickies");
        setStickyEntries(stickies || []);
        if (stickies && stickies.length > 0) {
          const { StickyManager } = await import("./features/sticky/StickyManager");
          await StickyManager.restoreAllStickies(stickies);
        }
      } catch (err) {
        console.error("Failed to restore stickies:", err);
      }
    };
    restore();
  }, []);

  // Listen for sticky windows closing themselves (emits "sticky-closed")
  useEffect(() => {
    const unlisten = listen("sticky-closed", () => {
      fetchStickies();
    });
    return () => { unlisten.then((u) => u()); };
  }, [fetchStickies]);

  // Refresh sticky panel when a sticky's content is edited (emits "sticky-updated")
  useEffect(() => {
    const unlisten = listen("sticky-updated", () => {
      fetchStickies();
    });
    return () => { unlisten.then((u) => u()); };
  }, [fetchStickies]);

  useEffect(() => {
    if (settingsLoaded) {
      fetchHistory(true);
    }
  }, [settingsLoaded, fetchHistory]);

  useToastListener({ pushToast });

  useSettingsPanelReset({ showSettings, setCollapsedGroups: setCollapsedGroupsAdapter });

  useTagManagerRefresh({
    showTagManager: effectiveShowTagManager,
    settingsLoaded,
    persistentLimitEnabled,
    persistentLimit,
    fetchHistory
  });

  const saveAppSetting = useCallback(async (type: string, path: string) => {
    const key = `app.${type}`;
    try {
      if (type === 'compact_mode') localStorage.setItem('winpaste_compact_mode', path);
    } catch (e) {}

    try {
      await invoke("save_setting", { key, value: path });
      // Keep the raw settings snapshot in sync so panels that read app.* keys
      // (e.g. 默认打开程序) reflect the change immediately.
      setAppSettings({ ...useSettingsStore.getState().appSettings, [key]: path });
    } catch (err) {
      console.error("保存设置失败", err);
    }
  }, [setAppSettings]);

  useSettingsSync({
    settingsLoaded,
    deduplicate,
    saveAppSetting,
    captureFiles,
    captureRichText,
    persistent,
    soundVolume,
    vibrancyEnabled,
    colorMode,
    stickyEnabled,
    arrowKeySelection,
    setIsKeyboardMode: setIsKeyboardMode as any,
    setSelectedIndex: setSelectedIndexAdapter
  });

  const {
    checkHotkeyConflict,
    updateHotkey,
    updateSequentialHotkey,
    updateRichPasteHotkey,
    updateSearchHotkey
  } = useHotkeyConfig({
      hotkey,
      setHotkey: setHotkey as any,
      sequentialHotkey,
      setSequentialHotkey: setSequentialHotkey as any,
      richPasteHotkey,
      setRichPasteHotkey: setRichPasteHotkey as any,
      searchHotkey,
      setSearchHotkey: setSearchHotkey as any,
      sequentialMode,
      isRecording,
      setIsRecording: setIsRecording as any,
      isRecordingSequential,
      setIsRecordingSequential: setIsRecordingSequential as any,
      isRecordingRich,
      setIsRecordingRich: setIsRecordingRich as any,
      isRecordingSearch,
      setIsRecordingSearch: setIsRecordingSearch as any,
      saveAppSetting,
      t,
      pushToast
    });

  useNavigationSync({ showSettings, showTagManager: effectiveShowTagManager });

  const { copyToClipboard, openContent, deleteEntry, togglePin, createSticky, handleUpdateTags } =
    useClipboardActions({
      t,
      pushToast,
      deleteAfterPaste,
      moveToTopAfterPaste,
      setSearch: setSearch as any,
      setHistory: setHistoryAdapter,
      virtualListRef,
      onStickyCreated: fetchStickies
    });

  const markExternalMissing = useCallback((id: number) => {
    setHistory((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, file_preview_exists: false } : item
      )
    );
  }, [setHistory]);

  const { clearHistory, handleResetSettings } = useAppActions({
    t,
    openConfirm,
    closeConfirm,
    pushToast,
    fetchHistory
  });

  const filteredHistory = useFilteredHistory({
    history,
    debouncedSearch,
    search,
    typeFilter
  });

  const { pinnedItems, unpinnedItems, handlePinnedReorder } = usePinnedSort({
    filteredHistory,
    history,
    setHistory: setHistoryAdapter
  });

  const navigationHistory = unpinnedItems;
  const pinnedCount = pinnedItems.length;

  const setSelectedIndexAdapterVirtual = useCallback((action: React.SetStateAction<number>) => {
    if (typeof action === 'function') {
      const currentGlobalIdx = useHistoryStore.getState().selectedIndex;
      const currentUnpinnedIdx = Math.max(0, currentGlobalIdx - pinnedCount);
      const nextUnpinnedIdx = action(currentUnpinnedIdx);
      setSelectedIndex(nextUnpinnedIdx + pinnedCount);
    } else {
      setSelectedIndex(action + pinnedCount);
    }
  }, [setSelectedIndex, pinnedCount]);

  useListSelectionReset({ filteredHistory: navigationHistory, setSelectedIndex: setSelectedIndexAdapterVirtual });

  useSearchFetchTrigger({ debouncedSearch, isComposing, typeFilter, fetchHistory });

  useScrollToSelection({
    filteredHistory: navigationHistory,
    selectedIndex: Math.max(0, selectedIndex - pinnedCount),
    isKeyboardMode,
    pinnedCount: 0,
    virtualListRef
  });

  useKeyboardNavigation({
    filteredHistory: navigationHistory,
    selectedIndex: Math.max(0, selectedIndex - pinnedCount),
    setSelectedIndex: setSelectedIndexAdapterVirtual,
    isKeyboardMode,
    setIsKeyboardMode: setIsKeyboardMode as any,
    showSettings,
    showTagManager: effectiveShowTagManager,
    editingTagsId,
    arrowKeySelection,
    searchInputRef,
    copyToClipboard,
    openContent,
    setSearch: setSearch as any,
    setShowSearchBox
  });

  const { renderItemContent } = useClipboardItemRenderer({
    copyToClipboard,
    setSelectedIndex: setSelectedIndexAdapter,
    setRevealedIds: setRevealedIdsAdapter,
    openContent,
    togglePin,
    deleteEntry,
    createSticky: stickyEnabled ? createSticky : undefined as any,
    setEditingTagsId: setEditingTagsId as any,
    tagInput: tagInput,
    setTagInput: setTagInput as any,
    handleUpdateTags,
    markExternalMissing,
    t
  });

  const settingsPanelProps = useSettingsPanelProps({
    t,
    language,
    hotkeyParts,
    checkHotkeyConflict,
    updateHotkey,
    updateSequentialHotkey,
    updateRichPasteHotkey,
    updateSearchHotkey,
    saveAppSetting,
    handleResetSettings,
    toggleGroup,
    state: {
      ...settingsState,
      ...historyState,
      ...uiState,
      onToggleSticky: (enabled: boolean) => {
        settingsState.setStickyEnabled(enabled);
        invoke("save_setting", { key: "app.sticky_enabled", value: String(enabled) });
      },
    } as any
  });

  return (
    <div className="app-container">
      <AppHeader
        t={t}
        searchInputRef={searchInputRef}
        allTags={allTags}
        clearHistory={clearHistory}
      />

      <main
        className="main-content"
        style={{ overflowY: (showSettings || effectiveShowTagManager) ? 'auto' : 'hidden' }}
        onWheel={handleMainWheel}
      >
        <AppMainContent
          t={t}
          settingsPanelProps={settingsPanelProps}
          filteredHistory={filteredHistory}
          pinnedItems={pinnedItems}
          unpinnedItems={unpinnedItems}
          virtualListRef={virtualListRef}
          handlePinnedReorder={handlePinnedReorder}
          renderItemContent={renderItemContent}
          loadMoreHistory={loadMoreHistory}
          handleListScroll={handleListScroll}
          stickyEntries={stickyEntries}
          onStickyRemoved={fetchStickies}
          stickyEnabled={stickyEnabled}
          showScrollTop={showScrollTopVisible}
          onScrollTop={handleScrollTop}
        />
      </main>

      <ToastContainer toasts={toasts} />

      <ConfirmDialog
        open={confirmDialog.show}
        title={confirmDialog.title}
        message={confirmDialog.message}
        options={confirmDialog.options}
        confirmLabel={t('confirm')}
        cancelLabel={t('cancel')}
        onClose={closeConfirm}
        onConfirm={confirmDialog.onConfirm}
      />
    </div>
  );
}

export default App;
