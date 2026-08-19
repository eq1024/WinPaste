import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { ClipboardEntry } from "../types";
import type { VirtualClipboardListHandle } from "../../features/clipboard/types";

interface UseScrollToSelectionOptions {
  filteredHistory: ClipboardEntry[];
  selectedIndex: number;
  isKeyboardMode: boolean;
  idPrefix?: string;
  pinnedCount?: number;
  virtualListRef?: RefObject<VirtualClipboardListHandle | null>;
}

export const useScrollToSelection = ({
  filteredHistory,
  selectedIndex,
  isKeyboardMode,
  idPrefix = "clipboard-item-",
  pinnedCount = 0,
  virtualListRef
}: UseScrollToSelectionOptions) => {
  const prevIndexRef = useRef<number>(selectedIndex);

  // 供按帧校正循环读取的最新上下文（避免闭包捕获过期值）
  const ctxRef = useRef({ filteredHistory, selectedIndex, idPrefix });
  ctxRef.current = { filteredHistory, selectedIndex, idPrefix };

  // 向上贴边模式：开启后按帧校正，保证选中项始终紧贴滚动容器顶部边缘
  const upBoundaryRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const stableFramesRef = useRef(0);
  const lastIdxRef = useRef<number | null>(null);

  const stopLoop = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const tick = () => {
    rafRef.current = null;
    if (!upBoundaryRef.current) return;

    const { filteredHistory: hist, selectedIndex: idx, idPrefix: prefix } = ctxRef.current;
    const item = hist[idx];
    const el = item ? document.getElementById(`${prefix}${item.id}`) : null;
    const scroller = el ? (el.closest<HTMLElement>("[data-virtuoso-scroller]") ?? null) : null;

    if (el && scroller) {
      const rect = el.getBoundingClientRect();
      const containerTop = scroller.getBoundingClientRect().top;
      const gap = rect.top - containerTop;

      if (Math.abs(gap) > 1) {
        // 补正：让选中项回到与顶部边缘齐平
        scroller.scrollTop += gap;
        stableFramesRef.current = 0;
      } else if (lastIdxRef.current === idx) {
        // 连续多帧无偏差且选中项未变化：视为已稳定，停止循环
        stableFramesRef.current += 1;
      } else {
        stableFramesRef.current = 0;
      }
      lastIdxRef.current = idx;

      if (stableFramesRef.current >= 20) {
        upBoundaryRef.current = false;
        return;
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  };

  const ensureLoop = () => {
    if (rafRef.current === null) {
      stableFramesRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    }
  };

  // 组件卸载时停止循环
  useEffect(() => () => stopLoop(), []);

  useEffect(() => {
    if (isKeyboardMode && selectedIndex >= 0 && selectedIndex < filteredHistory.length) {
      const item = filteredHistory[selectedIndex];
      const direction = selectedIndex - prevIndexRef.current;
      prevIndexRef.current = selectedIndex;

      // 向下移动时退出向上贴边模式
      if (direction > 0) {
        upBoundaryRef.current = false;
        stopLoop();
      }

      const isPinned = selectedIndex < pinnedCount;
      if (isPinned && virtualListRef?.current?.scrollToTop) {
        virtualListRef.current.scrollToTop();
        return;
      }

      const targetIndex = selectedIndex - pinnedCount;

      // 优先按 DOM 判断条目当前是否已在可视区域内。
      const el = document.getElementById(`${idPrefix}${item.id}`);
      if (el) {
        const scroller = el.closest<HTMLElement>("[data-virtuoso-scroller]");
        const rect = el.getBoundingClientRect();
        const containerTop = scroller ? scroller.getBoundingClientRect().top : 0;
        const containerBottom = scroller
          ? scroller.getBoundingClientRect().bottom
          : (window.innerHeight || document.documentElement.clientHeight);

        const fullyVisible = rect.top >= containerTop && rect.bottom <= containerBottom;

        if (fullyVisible) {
          // 向上贴边模式下，条目"完整可见但未贴边"是 Virtuoso 锚定偏移
          // 造成的——交给按帧循环立即补正。
          if (direction < 0 && upBoundaryRef.current) {
            ensureLoop();
          }
          return;
        }

        // 条目部分或完全在可视区外：用最小滚动量把它带进可视区。
        el.scrollIntoView({ behavior: "auto", block: "nearest" });

        // 向上移动时开启贴边校正循环。
        // Virtuoso 会在视口上方异步挂载新条目并做滚动锚定，
        // 未挂载条目的高度是估算值，锚定误差会让可见内容整体下移
        // （表现就是上方多出"大半个条目"）。按帧循环会持续把当前
        // 选中项补正回顶部边缘，保证与向下方向一致的稳定手感。
        if (direction < 0) {
          upBoundaryRef.current = true;
          ensureLoop();
        }
        return;
      }

      // 条目未挂载（离可视区较远，被虚拟列表回收）：
      // 通过 Virtuoso 按索引滚动。按移动方向选择对齐方式——
      // 向上对齐顶部、向下对齐底部，避免居中大跳导致列表来回晃动。
      if (virtualListRef?.current && targetIndex >= 0) {
        const align = direction < 0 ? "start" : direction > 0 ? "end" : "center";
        virtualListRef.current.scrollToItem(targetIndex, align);
        if (direction < 0) {
          upBoundaryRef.current = true;
          ensureLoop();
        }
        return;
      } else if (virtualListRef?.current && pinnedCount > 0) {
        virtualListRef.current.scrollToItem(0);
        return;
      }
    } else {
      // 键盘模式退出或索引失效时同步 ref，并停止贴边循环
      prevIndexRef.current = selectedIndex;
      upBoundaryRef.current = false;
      stopLoop();
    }
  }, [filteredHistory, selectedIndex, isKeyboardMode, idPrefix, pinnedCount, virtualListRef]);
};
