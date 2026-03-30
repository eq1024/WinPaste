import { useMemo } from "react";
import type { ClipboardEntry } from "../types";

interface UseFilteredHistoryOptions {
  history: ClipboardEntry[];
  debouncedSearch: string;
  search: string;
  typeFilter: string | null;
}

export const useFilteredHistory = ({
  history,
  debouncedSearch,
  search,
  typeFilter
}: UseFilteredHistoryOptions) => {
  return useMemo(() => {
    const lowerSearch = search.toLowerCase();

    const filtered = history.filter((item) => {
      if (typeFilter && item.content_type !== typeFilter) {
        return false;
      }

      // If search query starts with "tag:", only search within tags.
      if (lowerSearch.startsWith("tag:")) {
        const tagName = lowerSearch.slice(4).trim().toLowerCase();
        if (!tagName) return true;
        // Exact or partial match within tags only.
        return item.tags?.some((tag) => tag.toLowerCase().includes(tagName));
      }

      if (!lowerSearch) return true;

      // Normal search: content or tags.
      return (
        item.content?.toLowerCase().includes(lowerSearch) ||
        item.tags?.some((tag) => tag.toLowerCase().includes(lowerSearch))
      );
    });

    return filtered.sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) {
        return a.is_pinned ? -1 : 1;
      }
      if (a.is_pinned) {
        if ((a.pinned_order || 0) !== (b.pinned_order || 0)) {
          return (b.pinned_order || 0) - (a.pinned_order || 0);
        }
        return b.timestamp - a.timestamp;
      }
      return b.timestamp - a.timestamp;
    });
  }, [history, debouncedSearch, search, typeFilter]);
};


