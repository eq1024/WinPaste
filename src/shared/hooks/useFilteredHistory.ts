import { useMemo } from "react";
import type { ClipboardEntry } from "../types";

interface UseFilteredHistoryOptions {
  history: ClipboardEntry[];
  debouncedSearch: string;
  search: string;
  typeFilter: string | null;
}

// Image entries store their content as multi-MB `data:` base64 URLs, and
// session (unpersisted) text entries are not truncated by the backend.
// Lowercasing those giant strings on EVERY keystroke copies hundreds of MB
// per key press — this was the search-time freeze / 2GB memory spike.
// Base64 images never match a search: only entries with a local address
// source participate, through that address (source_file_path) — e.g. an
// image copied from folder "xx1" is found by searching "xx", while a
// screenshot (no path) is not searchable. Other content is capped so a
// keystroke never lowercases hundreds of MB.
//
// SQLite's substr(ch.content, 1, 100000) counts characters, while this slice is
// taken in UTF-16 code units. One character is at most 2 UTF-16 units (and at
// most 4 UTF-8 bytes), so 400_000 units always covers the 100_000 characters
// the SQL side inspects. Staying >= 4x the SQL cap is what keeps this
// second-pass filter a superset of the backend match — otherwise an entry the
// backend legitimately returned could be silently dropped here.
const MAX_SEARCHABLE_CONTENT_LEN = 400_000;

// Case-insensitive `data:` prefix check — mirrors SQLite's case-insensitive
// `NOT LIKE 'data:%'` so a `DATA:...` payload can't be treated as searchable
// text here while the backend already excluded it.
const isDataUrl = (s: string): boolean => s.slice(0, 5).toLowerCase() === "data:";

const getSearchableContent = (item: ClipboardEntry): string => {
  const content = item.content;
  // Base64 images arrive in the list with empty content (thumbnail only);
  // their local address source (source_file_path) is what participates.
  if (!content || isDataUrl(content)) {
    return item.source_file_path ?? "";
  }
  if (content.length > MAX_SEARCHABLE_CONTENT_LEN) {
    return content.slice(0, MAX_SEARCHABLE_CONTENT_LEN);
  }
  return content;
};

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

      // Normal search: content (or local address), source app, or tags.
      // source_app MUST be checked here too — the backend search already
      // matches it, and dropping it in this second pass would make
      // source-app matches (e.g. "weixin" for a WeChat image) vanish.
      return (
        getSearchableContent(item).toLowerCase().includes(lowerSearch) ||
        item.source_app?.toLowerCase().includes(lowerSearch) ||
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


