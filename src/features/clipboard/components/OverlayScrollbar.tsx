import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * OverlayScrollbar
 *
 * 一个不占布局空间的覆盖式滚动条（OverlayScrollbars 风格），
 * 用于 react-virtuoso 的词条列表。它不接管滚动，只被动同步
 * `scroller` 的 scrollTop / scrollHeight / clientHeight，
 * 因此与虚拟化逻辑完全解耦。
 */

const THUMB_MIN_HEIGHT = 24;
const IDLE_HIDE_DELAY_MS = 700;
const LEAVE_HIDE_DELAY_MS = 300;

interface OverlayScrollbarProps {
  /** Virtuoso 的滚动容器元素（通过 scrollerRef 拿到），为 null 时组件不工作 */
  scroller: HTMLElement | null;
  /** 内容总高度变化（加载更多 / 删除 / 置顶等）时通知滚动条重新测量 */
  onRegisterRefresh?: (refresh: (() => void) | null) => void;
}

interface Metrics {
  scrollHeight: number;
  clientHeight: number;
  trackHeight: number;
  thumbHeight: number;
}

export const OverlayScrollbar: React.FC<OverlayScrollbarProps> = ({
  scroller,
  onRegisterRefresh,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const metricsRef = useRef<Metrics>({
    scrollHeight: 0,
    clientHeight: 0,
    trackHeight: 0,
    thumbHeight: 0,
  });
  const dragStateRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
  } | null>(null);
  const hoveringRef = useRef(false);

  const [scrollable, setScrollable] = useState(false);
  const [thumbHeight, setThumbHeight] = useState(0);
  const [thumbOffset, setThumbOffset] = useState(0);
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState(false);

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(
    (delay: number) => {
      cancelHide();
      hideTimerRef.current = window.setTimeout(() => {
        hideTimerRef.current = null;
        if (!dragStateRef.current && !hoveringRef.current) {
          setVisible(false);
        }
      }, delay);
    },
    [cancelHide]
  );

  const update = useCallback(() => {
    if (!scroller) return;
    const track = trackRef.current;
    if (!track) return;

    const { scrollTop, scrollHeight, clientHeight } = scroller;
    const trackHeight = track.clientHeight;

    if (scrollHeight <= clientHeight || trackHeight <= 0) {
      setScrollable(false);
      return;
    }

    const thumbHeight = Math.max(
      THUMB_MIN_HEIGHT,
      (clientHeight / scrollHeight) * trackHeight
    );
    const maxScrollTop = scrollHeight - clientHeight;
    const maxThumbTravel = trackHeight - thumbHeight;
    const thumbOffset =
      maxScrollTop <= 0 ? 0 : (scrollTop / maxScrollTop) * maxThumbTravel;

    metricsRef.current = { scrollHeight, clientHeight, trackHeight, thumbHeight };
    setScrollable(true);
    setThumbHeight(thumbHeight);
    setThumbOffset(thumbOffset);
  }, [scroller]);

  // 监听滚动容器的滚动 / 悬停 / 尺寸变化
  useEffect(() => {
    if (!scroller) return;

    update();

    const handleScroll = () => {
      update();
      setVisible(true);
      // 滚动期间显示；若鼠标正悬停在列表/轨道上则保持可见，否则滚动停止后延时隐藏
      if (hoveringRef.current) {
        cancelHide();
      } else {
        scheduleHide(IDLE_HIDE_DELAY_MS);
      }
    };
    const handleMouseEnter = () => {
      hoveringRef.current = true;
      setVisible(true);
      cancelHide();
    };
    const handleMouseLeave = () => {
      hoveringRef.current = false;
      scheduleHide(LEAVE_HIDE_DELAY_MS);
    };

    scroller.addEventListener("scroll", handleScroll);
    scroller.addEventListener("mouseenter", handleMouseEnter);
    scroller.addEventListener("mouseleave", handleMouseLeave);

    const ro = new ResizeObserver(() => update());
    ro.observe(scroller);
    if (trackRef.current) ro.observe(trackRef.current);

    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      scroller.removeEventListener("mouseenter", handleMouseEnter);
      scroller.removeEventListener("mouseleave", handleMouseLeave);
      ro.disconnect();
      cancelHide();
    };
  }, [scroller, update, cancelHide, scheduleHide]);

  // 向父组件注册「内容高度变化时重新测量」的回调
  useEffect(() => {
    onRegisterRefresh?.(update);
    return () => onRegisterRefresh?.(null);
  }, [onRegisterRefresh, update]);

  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scroller) return;
    e.preventDefault();
    e.stopPropagation();
    dragStateRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startScrollTop: scroller.scrollTop,
    };
    setDragging(true);
    cancelHide();
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleThumbPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || !scroller || e.pointerId !== drag.pointerId) return;

    const m = metricsRef.current;
    const maxScrollTop = m.scrollHeight - m.clientHeight;
    const maxThumbTravel = m.trackHeight - m.thumbHeight;
    if (maxScrollTop <= 0 || maxThumbTravel <= 0) return;

    const dy = e.clientY - drag.startY;
    const scrollPerPx = maxScrollTop / maxThumbTravel;
    const nextScrollTop = Math.max(
      0,
      Math.min(maxScrollTop, drag.startScrollTop + dy * scrollPerPx)
    );
    scroller.scrollTop = nextScrollTop;
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragStateRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针捕获可能已释放 */
    }

    // 松手时指针仍悬停在轨道上则保持可见，等待 mouseleave 再隐藏
    const track = trackRef.current;
    const stillOver = (() => {
      if (!track) return false;
      const rect = track.getBoundingClientRect();
      return (
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom
      );
    })();
    if (!stillOver) scheduleHide(IDLE_HIDE_DELAY_MS);
  };

  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // 只有点击轨道空白处（非 thumb 本身）才跳转
    if (e.target !== e.currentTarget || !scroller) return;
    const track = trackRef.current;
    if (!track) return;

    const m = metricsRef.current;
    const maxScrollTop = m.scrollHeight - m.clientHeight;
    const maxThumbTravel = m.trackHeight - m.thumbHeight;
    if (maxScrollTop <= 0 || maxThumbTravel <= 0) return;

    const rect = track.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const ratio = Math.max(
      0,
      Math.min(1, (y - m.thumbHeight / 2) / maxThumbTravel)
    );
    scroller.scrollTop = ratio * maxScrollTop;
  };

  const handleTrackEnter = () => {
    hoveringRef.current = true;
    setVisible(true);
    cancelHide();
  };

  const handleTrackLeave = () => {
    hoveringRef.current = false;
    if (!dragStateRef.current) scheduleHide(LEAVE_HIDE_DELAY_MS);
  };

  const showBar = scrollable && (visible || dragging);
  const trackClass = [
    "overlay-scrollbar-track",
    scrollable ? "" : "disabled",
    showBar ? "visible" : "",
    dragging ? "dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={trackRef}
      className={trackClass}
      onMouseEnter={handleTrackEnter}
      onMouseLeave={handleTrackLeave}
      onClick={handleTrackClick}
    >
      <div
        className="overlay-scrollbar-thumb"
        style={{
          height: thumbHeight,
          transform: `translateY(${thumbOffset}px)`,
        }}
        onPointerDown={handleThumbPointerDown}
        onPointerMove={handleThumbPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="overlay-scrollbar-thumb-bar" />
      </div>
    </div>
  );
};

export default OverlayScrollbar;
