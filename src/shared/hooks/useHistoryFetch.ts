import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore } from "../store/historyStore";
import { useSettingsStore } from "../store/settingsStore";
import type { ClipboardEntry } from "../types";

interface UseHistoryFetchOptions {
  debouncedSearch: string;
}

export const useHistoryFetch = ({
  debouncedSearch
}: UseHistoryFetchOptions) => {
  const {
    typeFilter,
    currentOffset,
    history,
    setHistory,
    setCurrentOffset,
    setHasMore,
    hasMore,
    setIsLoadingMore,
    isLoadingMore
  } = useHistoryStore();

  const {
    persistentLimitEnabled,
    persistentLimit
  } = useSettingsStore();

  const loadingRef = useRef(false);
  const fetchSeqRef = useRef(0);
  const lastRequestedOffsetRef = useRef<number | null>(null);
  const currentOffsetRef = useRef(currentOffset);
  const historyLengthRef = useRef(history.length);

  useEffect(() => {
    currentOffsetRef.current = currentOffset;
  }, [currentOffset]);

  useEffect(() => {
    historyLengthRef.current = history.length;
  }, [history.length]);

  const PAGE_SIZE = 200;

  const fetchHistory = useCallback(
    async (reset = false) => {
      const seq = ++fetchSeqRef.current;
      try {
        if (reset) {
          lastRequestedOffsetRef.current = null;
        }

        const baseOffset = reset
          ? 0
          : Math.min(currentOffsetRef.current, historyLengthRef.current);

        let data: ClipboardEntry[] = [];

        const hasSearch = debouncedSearch && debouncedSearch.trim().length > 0;

        if (hasSearch) {
          let term = debouncedSearch;
          if (term.startsWith("tag:")) {
            term = term.slice(4);
          }

          try {
            data = await invoke<ClipboardEntry[]>("search_clipboard_history", {
              searchTerm: term,
              limit: 200
            });
          } catch (e) {
            console.error("Search failed, falling back", e);
            data = [];
          }

          if (seq !== fetchSeqRef.current) return;
          setHistory(data);
          setCurrentOffset(data.length);
          setHasMore(false);
        } else {
          const requestedLimit = PAGE_SIZE + 1;
          const rawData = await invoke<ClipboardEntry[]>("get_clipboard_history", {
            limit: requestedLimit,
            offset: baseOffset,
            content_type: typeFilter || undefined
          });

          if (seq !== fetchSeqRef.current) return;

          const hasMoreNow = rawData.length > PAGE_SIZE;
          const data = hasMoreNow ? rawData.slice(0, PAGE_SIZE) : rawData;
          const dbItemsCount = data.filter(item => item.id > 0).length;

          if (reset) {
            setHistory(data);
            setCurrentOffset(dbItemsCount);
            setHasMore(hasMoreNow);
          } else {
            let nextItems: ClipboardEntry[] = [];
            setHistory((prev) => {
              const existingIds = new Set(prev.map((item) => item.id));
              nextItems = data.filter((item) => !existingIds.has(item.id) || item.id === 0);

              if (nextItems.length === 0) return prev;
              return [...prev, ...nextItems];
            });

            setCurrentOffset(prev => (typeof prev === 'number' ? prev : 0) + dbItemsCount);
            setHasMore(hasMoreNow);
          }
        }
      } catch (err) {
        console.error("无法获取历史记录", err);
        setHasMore(false);
      }
    },
    [
      debouncedSearch,
      typeFilter,
      persistentLimit,
      persistentLimitEnabled,
      setCurrentOffset,
      setHasMore,
      setHistory
    ]
  );

  const loadMoreHistory = useCallback(async () => {
    if (loadingRef.current || isLoadingMore || !hasMore) return;
    if (debouncedSearch && debouncedSearch.trim().length > 0) return;

    const effectiveOffset = Math.min(currentOffsetRef.current, historyLengthRef.current);
    if (lastRequestedOffsetRef.current === effectiveOffset) return;
    lastRequestedOffsetRef.current = effectiveOffset;

    loadingRef.current = true;
    setIsLoadingMore(true);
    try {
      await fetchHistory(false);
    } finally {
      loadingRef.current = false;
      setIsLoadingMore(false);
    }
  }, [debouncedSearch, fetchHistory, hasMore, isLoadingMore, setIsLoadingMore]);

  return { fetchHistory, loadMoreHistory };
};
