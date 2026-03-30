import { create } from 'zustand';
import type { ClipboardEntry } from '../types';

interface HistoryState {
  history: ClipboardEntry[];
  search: string;
  isComposing: boolean;
  searchIsFocused: boolean;
  showTagFilter: boolean;
  tagInput: string;
  editingTagsId: number | null;
  revealedIds: Set<number>;
  selectedIndex: number;
  isKeyboardMode: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  currentOffset: number;
  typeFilter: string | null;

  // Actions
  setHistory: (history: ClipboardEntry[] | ((prev: ClipboardEntry[]) => ClipboardEntry[])) => void;
  setSearch: (search: string) => void;
  setIsComposing: (isComposing: boolean) => void;
  setSearchIsFocused: (focused: boolean) => void;
  setShowTagFilter: (show: boolean) => void;
  setTagInput: (input: string) => void;
  setEditingTagsId: (id: number | null | ((prev: number | null) => number | null)) => void;
  setRevealedIds: (ids: Set<number> | ((prev: Set<number>) => Set<number>)) => void;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  setIsKeyboardMode: (enabled: boolean) => void;
  setIsLoadingMore: (loading: boolean) => void;
  setHasMore: (hasMore: boolean) => void;
  setCurrentOffset: (offset: number | ((prev: number) => number)) => void;
  setTypeFilter: (filter: string | null) => void;
}

export const useHistoryStore = create<HistoryState>((set) => ({
  history: [],
  search: "",
  isComposing: false,
  searchIsFocused: false,
  showTagFilter: false,
  tagInput: "",
  editingTagsId: null,
  revealedIds: new Set(),
  selectedIndex: 0,
  isKeyboardMode: false,
  isLoadingMore: false,
  hasMore: true,
  currentOffset: 0,
  typeFilter: null,

  setHistory: (history) => set((state) => ({ 
    history: typeof history === 'function' ? history(state.history) : history 
  })),
  setSearch: (search) => set({ search }),
  setIsComposing: (isComposing) => set({ isComposing }),
  setSearchIsFocused: (searchIsFocused) => set({ searchIsFocused }),
  setShowTagFilter: (showTagFilter) => set({ showTagFilter }),
  setTagInput: (tagInput) => set({ tagInput }),
  setEditingTagsId: (editingTagsId) => set((state) => ({
    editingTagsId: typeof editingTagsId === 'function' ? (editingTagsId as any)(state.editingTagsId) : editingTagsId
  })),
  setRevealedIds: (revealedIds) => set((state) => ({ 
    revealedIds: typeof revealedIds === 'function' ? (revealedIds as any)(state.revealedIds) : revealedIds 
  })),
  setSelectedIndex: (selectedIndex) => set((state) => ({ 
    selectedIndex: typeof selectedIndex === 'function' ? (selectedIndex as any)(state.selectedIndex) : selectedIndex 
  })),
  setIsKeyboardMode: (isKeyboardMode) => set({ isKeyboardMode }),
  setIsLoadingMore: (isLoadingMore) => set({ isLoadingMore }),
  setHasMore: (hasMore) => set({ hasMore }),
  setCurrentOffset: (currentOffset) => set((state) => ({ 
    currentOffset: typeof currentOffset === 'function' ? currentOffset(state.currentOffset) : currentOffset 
  })),
  setTypeFilter: (typeFilter) => set({ typeFilter }),
}));
