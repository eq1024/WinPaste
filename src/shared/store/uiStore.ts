import { create } from 'zustand';

interface UIState {
  showSettings: boolean;
  showTagManager: boolean;
  tagManagerEnabled: boolean;
  collapsedGroups: Record<string, boolean>;
  showAppSelector: string | null;
  isWindowPinned: boolean;
  showSearchBox: boolean;
  scrollTopButtonEnabled: boolean;
  showHotkeyHint: boolean;
  isRecording: boolean;
  isRecordingSequential: boolean;
  isRecordingRich: boolean;
  isRecordingSearch: boolean;

  // Actions
  setShowSettings: (show: boolean) => void;
  setShowTagManager: (show: boolean) => void;
  setTagManagerEnabled: (enabled: boolean) => void;
  setCollapsedGroups: (groups: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void;
  setShowAppSelector: (selector: string | null) => void;
  setIsWindowPinned: (pinned: boolean) => void;
  setShowSearchBox: (show: boolean) => void;
  setScrollTopButtonEnabled: (enabled: boolean) => void;
  setShowHotkeyHint: (show: boolean) => void;
  setIsRecording: (isRecording: boolean) => void;
  setIsRecordingSequential: (isRecordingSequential: boolean) => void;
  setIsRecordingRich: (isRecordingRich: boolean) => void;
  setIsRecordingSearch: (isRecordingSearch: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  showSettings: false,
  showTagManager: false,
  tagManagerEnabled: true,
  collapsedGroups: {
    general: true,
    clipboard: true,
    appearance: true,
    default_apps: true,
    data: true
  },
  showAppSelector: null,
  isWindowPinned: false,
  showSearchBox: true,
  scrollTopButtonEnabled: true,
  showHotkeyHint: false,
  isRecording: false,
  isRecordingSequential: false,
  isRecordingRich: false,
  isRecordingSearch: false,

  setShowSettings: (showSettings) => set({ showSettings }),
  setShowTagManager: (showTagManager) => set({ showTagManager }),
  setTagManagerEnabled: (tagManagerEnabled) => set({ tagManagerEnabled }),
  setCollapsedGroups: (collapsedGroups) => set((state) => ({ 
    collapsedGroups: typeof collapsedGroups === 'function' ? collapsedGroups(state.collapsedGroups) : collapsedGroups 
  })),
  setShowAppSelector: (showAppSelector) => set({ showAppSelector }),
  setIsWindowPinned: (isWindowPinned) => set({ isWindowPinned }),
  setShowSearchBox: (showSearchBox) => set({ showSearchBox }),
  setScrollTopButtonEnabled: (scrollTopButtonEnabled) => set({ scrollTopButtonEnabled }),
  setShowHotkeyHint: (showHotkeyHint) => set({ showHotkeyHint }),
  setIsRecording: (isRecording) => set({ isRecording }),
  setIsRecordingSequential: (isRecordingSequential) => set({ isRecordingSequential }),
  setIsRecordingRich: (isRecordingRich) => set({ isRecordingRich }),
  setIsRecordingSearch: (isRecordingSearch) => set({ isRecordingSearch }),
}));
