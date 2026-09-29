import { useEffect, useRef } from "react";
import type { ClipboardEntry } from "../types";

interface UseListSelectionResetOptions {
  filteredHistory: ClipboardEntry[];
  /** 当前选中下标（与本 hook 收到的 filteredHistory 同一坐标系，不含置顶偏移）。 */
  selectedIndex: number;
  setSelectedIndex: (val: number) => void;
}

// 搜索的每次防抖落定都会把结果整体替换成新对象数组，旧实现只要列表引用一
// 变就把选中归零 —— 用户刚用方向键选好的条目在结果落地瞬间被跳回第一行，
// 表现为"搜索后必须选两次"。这里改为按条目 id 保持选中：列表替换时把选中
// 迁移到同一条目的新位置，找不到时才回落到第一行。
export const useListSelectionReset = ({
  filteredHistory,
  selectedIndex,
  setSelectedIndex
}: UseListSelectionResetOptions) => {
  const lastSelectedIdRef = useRef<number | null>(null);
  const listRef = useRef<ClipboardEntry[]>(filteredHistory);

  // 列表被替换（搜索落定 / 剪贴板更新 / 筛选切换）时，把选中迁移到
  // 同一条目在新列表中的位置。
  useEffect(() => {
    if (listRef.current === filteredHistory) return;
    listRef.current = filteredHistory;

    const id = lastSelectedIdRef.current;
    const idx = id !== null
      ? filteredHistory.findIndex((item) => item.id === id)
      : -1;
    setSelectedIndex(idx >= 0 ? idx : 0);
  }, [filteredHistory, setSelectedIndex]);

  // 列表未变时（方向键移动选中）跟踪当前选中的条目 id。
  useEffect(() => {
    const item = filteredHistory[selectedIndex];
    if (item) {
      lastSelectedIdRef.current = item.id;
    }
  }, [filteredHistory, selectedIndex]);
};
