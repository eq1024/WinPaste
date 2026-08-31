import React, { useRef, useImperativeHandle, useCallback, useMemo, useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import type { ClipboardEntry } from "../../../shared/types";
import type { VirtualClipboardListHandle, VirtualClipboardListProps } from "../types";
import { OverlayScrollbar } from "./OverlayScrollbar";

type VirtuosoListContext = {
    header?: React.ReactNode;
    hasMore: boolean;
    isLoading: boolean;
};

const ListHeader = ({ context }: { context?: VirtuosoListContext }) => {
    const header = context?.header;
    return header ? <div className="list-header">{header}</div> : null;
};

const ListFooter = ({ context }: { context?: VirtuosoListContext }) => {
    if (!context) return null;
    const { isLoading, hasMore } = context;
    if (!isLoading && !hasMore) return null;

    return (
        <div style={{
            padding: '20px',
            textAlign: 'center',
            opacity: 0.6,
            fontSize: '12px',
            color: 'var(--text-secondary)'
        }}>
            {isLoading ? '加载中...' : '加载更多...'}
        </div>
    );
};

const VirtualClipboardList = React.forwardRef<VirtualClipboardListHandle, VirtualClipboardListProps>(
    (props, ref) => {
        const {
            items,
            renderItem,
            onLoadMore,
            hasMore,
            isLoading,
            onScroll,
            compactMode,
            header
        } = props;

        const virtuosoRef = useRef<VirtuosoHandle>(null);
        const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
        const scrollbarRefreshRef = useRef<(() => void) | null>(null);
        useImperativeHandle(ref, () => ({
            // 键盘导航的滚动统一由 useScrollToSelection 驱动。
            // 只有目标条目被虚拟列表回收（未挂载、距离较远）时才会走到这里：
            // 按移动方向选择对齐方式，向上对齐顶部、向下对齐底部，
            // 避免居中大跳导致列表来回晃动。
            scrollToItem: (index: number, align: 'start' | 'center' | 'end' = 'center') => {
                virtuosoRef.current?.scrollIntoView({
                    index,
                    behavior: 'auto',
                    align,
                });
            },
            scrollToTop: () => {
                virtuosoRef.current?.scrollTo({
                    top: 0,
                    behavior: 'auto'
                });
            },
            resetAfterIndex: (_index: number) => {
                // Not needed with Virtuoso as it handles dynamic heights automatically
            }
        }));

        // Handle scroll events
        const handleScroll = useCallback((scrollTop: number) => {
            onScroll?.(scrollTop);
        }, [onScroll]);

        // Handle end reached for infinite loading
        const handleEndReached = useCallback(() => {
            if (hasMore && !isLoading && onLoadMore) {
                onLoadMore();
            }
        }, [hasMore, isLoading, onLoadMore]);

        // Memoized item renderer for Virtuoso
        const itemContent = useCallback((index: number, item: ClipboardEntry) => {
            return (
                <div style={{ paddingBottom: compactMode ? 2 : 4, width: 'calc(100% - 12px)' }}>
                    {renderItem(item, index, index === 0)}
                </div>
            );
        }, [renderItem, compactMode]);

        const components = useMemo(() => ({
            Header: ListHeader,
            Footer: ListFooter
        }), []);

        const context = useMemo(() => ({
            header,
            hasMore,
            isLoading
        }), [header, hasMore, isLoading]);

        return (
            <div className="virtual-list-wrapper" style={{ height: '100%', width: '100%' }}>
                <Virtuoso
                    ref={virtuosoRef}
                    data={items}
                    itemContent={itemContent}
                    components={components}
                    context={context}
                    style={{ height: '100%' }}
                    onScroll={(e) => handleScroll((e.currentTarget as HTMLElement).scrollTop)}
                    endReached={handleEndReached}
                    overscan={200} // Pre-render 200px of content for smoother scrolling
                    scrollerRef={(ref) => setScrollerEl(ref instanceof HTMLElement ? ref : null)}
                    totalListHeightChanged={() => scrollbarRefreshRef.current?.()}
                />
                <OverlayScrollbar
                    scroller={scrollerEl}
                    onRegisterRefresh={(fn) => { scrollbarRefreshRef.current = fn; }}
                />
            </div>
        );
    }
);

VirtualClipboardList.displayName = 'VirtualClipboardList';

export { VirtualClipboardList };
export default VirtualClipboardList;
