import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, RefObject, ReactNode } from "react";
import { motion, Reorder, useDragControls, AnimatePresence } from "framer-motion";
import type { DragControls } from "framer-motion";
import { ArrowUp, Clipboard } from "lucide-react";
import SettingsPanel from "../../settings/components/SettingsPanel";
import TagManager from "../../tag/components/TagManager";
import { VirtualClipboardList } from "../../clipboard/components/VirtualClipboardList";
import type { ClipboardEntry } from "../../../shared/types";
import type { VirtualClipboardListHandle } from "../../clipboard/types";
import { useSettingsStore } from "../../../shared/store/settingsStore";
import { useHistoryStore } from "../../../shared/store/historyStore";
import { useUIStore } from "../../../shared/store/uiStore";

type SettingsPanelProps = ComponentProps<typeof SettingsPanel>;
type RenderItem = (
  item: ClipboardEntry,
  index: number,
  dragControls?: DragControls,
  disableLayout?: boolean
) => ReactNode;

interface AppMainContentProps {
  t: (key: string) => string;
  settingsPanelProps: SettingsPanelProps;
  filteredHistory: ClipboardEntry[];
  pinnedItems: ClipboardEntry[];
  unpinnedItems: ClipboardEntry[];
  virtualListRef: RefObject<VirtualClipboardListHandle | null>;
  handlePinnedReorder: (newOrderIds: number[]) => void;
  renderItemContent: RenderItem;
  loadMoreHistory: () => void;
  handleListScroll: (offset: number) => void;
  showScrollTop: boolean;
  onScrollTop: () => void;
}

const SortableItem = ({
  item,
  index,
  renderItem,
  isFirst,
  onDragStart,
  onDragEnd
}: {
  item: ClipboardEntry;
  index: number;
  renderItem: RenderItem;
  isFirst?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) => {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={item.id}
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={isFirst ? "first-virtual-item" : undefined}
      style={{
        listStyle: "none",
        overflow: "visible",
        paddingTop: isFirst ? "4px" : undefined
      }}
    >
      {renderItem(item, index, controls, true)}
    </Reorder.Item>
  );
};

const AppMainContent = ({
  t,
  settingsPanelProps,
  filteredHistory,
  pinnedItems,
  unpinnedItems,
  virtualListRef,
  handlePinnedReorder,
  renderItemContent,
  loadMoreHistory,
  handleListScroll,
  showScrollTop,
  onScrollTop
}: AppMainContentProps) => {
  const {
    showSettings,
    showTagManager,
    tagManagerEnabled,
  } = useUIStore();

  const {
    compactMode,
  } = useSettingsStore();

  const {
    search,
    selectedIndex,
    isKeyboardMode,
    hasMore,
    isLoadingMore
  } = useHistoryStore();

  const [pinnedOrderIds, setPinnedOrderIds] = useState<number[]>(
    () => pinnedItems.map((item) => item.id)
  );
  const pinnedOrderRef = useRef<number[]>(pinnedItems.map((item) => item.id));
  const [isDraggingPinned, setIsDraggingPinned] = useState(false);

  useEffect(() => {
    if (isDraggingPinned) return;
    const next = pinnedItems.map((item) => item.id);
    setPinnedOrderIds(next);
    pinnedOrderRef.current = next;
  }, [pinnedItems, isDraggingPinned]);

  const orderedPinnedItems = useMemo(() => {
    if (pinnedItems.length === 0) return [];
    const map = new Map<number, ClipboardEntry>();
    pinnedItems.forEach((item) => map.set(item.id, item));

    const ordered: ClipboardEntry[] = [];
    const seen = new Set<number>();

    pinnedOrderIds.forEach((id) => {
      const item = map.get(id);
      if (!item) return;
      ordered.push(item);
      seen.add(id);
    });

    pinnedItems.forEach((item) => {
      if (!seen.has(item.id)) {
        ordered.push(item);
      }
    });

    return ordered;
  }, [pinnedItems, pinnedOrderIds]);

  const orderedPinnedIds = useMemo(
    () => orderedPinnedItems.map((item) => item.id),
    [orderedPinnedItems]
  );

  const handlePinnedIdsReorder = useCallback((nextIds: number[]) => {
    setPinnedOrderIds(nextIds);
    pinnedOrderRef.current = nextIds;
  }, []);

  const handlePinnedDragStart = useCallback(() => {
    setIsDraggingPinned(true);
  }, []);

  const handlePinnedDragEnd = useCallback(() => {
    setIsDraggingPinned(false);
    const finalIds = pinnedOrderRef.current;
    const currentIds = pinnedItems.map((item) => item.id);
    if (
      finalIds.length === currentIds.length &&
      finalIds.every((id, idx) => id === currentIds[idx])
    ) {
      return;
    }
    handlePinnedReorder(finalIds);
  }, [handlePinnedReorder, pinnedItems]);

  const transitionConfig = {
    initial: { opacity: 0, scale: 0.98 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, scale: 0.98 },
    transition: { duration: 0.15, ease: "easeOut" as const }
  };

  return (
    <AnimatePresence mode="wait">
      {showTagManager && tagManagerEnabled ? (
        <motion.div
          key="tag-manager"
          {...transitionConfig}
          style={{ height: "100%" }}
        >
          <TagManager t={t} theme="fluent" />
        </motion.div>
      ) : showSettings ? (
        <motion.div
          key="settings-panel"
          {...transitionConfig}
          className="settings-view"
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <SettingsPanel {...settingsPanelProps} />
        </motion.div>
      ) : filteredHistory.length === 0 ? (
        <motion.div
          key="empty-state"
          {...transitionConfig}
          className="empty-state"
        >
          <Clipboard size={40} opacity={0.2} style={{ marginBottom: "12px" }} />
          {search ? (
            <p>{t("no_records")}</p>
          ) : (
            <>
              <p
                style={{
                  fontSize: "15px",
                  fontWeight: "bold",
                  color: "var(--text-primary)",
                  marginBottom: "4px"
                }}
              >
                {t("empty_title")}
              </p>
              <p style={{ fontSize: "12px", opacity: 0.6 }}>{t("empty_desc")}</p>
            </>
          )}
        </motion.div>
      ) : (
        <motion.div
          key="main-list"
          {...transitionConfig}
          className="history-list-container"
        >
          <VirtualClipboardList
            ref={virtualListRef}
            items={unpinnedItems}
            compactMode={compactMode}
            selectedIndex={selectedIndex - pinnedItems.length}
            isKeyboardMode={isKeyboardMode}
            header={
              pinnedItems.length > 0 ? (
                <Reorder.Group
                  axis="y"
                  values={orderedPinnedIds}
                  onReorder={handlePinnedIdsReorder}
                  className={isDraggingPinned ? "pinned-reorder dragging" : "pinned-reorder"}
                  style={{ listStyle: "none", padding: 0 }}
                >
                  {orderedPinnedItems.map((item, index) => (
                    <SortableItem
                      key={item.id}
                      item={item}
                      index={index}
                      renderItem={renderItemContent}
                      isFirst={index === 0}
                      onDragStart={handlePinnedDragStart}
                      onDragEnd={handlePinnedDragEnd}
                    />
                  ))}
                </Reorder.Group>
              ) : null
            }
            renderItem={(item, index, isFirst?: boolean) => {
              const el = renderItemContent(item, pinnedItems.length + index, undefined, true);
              if (isFirst && pinnedItems.length === 0) {
                return (
                  <div className="first-virtual-item" style={{ height: "100%", paddingTop: "4px" }}>
                    {el}
                  </div>
                );
              }
              return el;
            }}
            onLoadMore={loadMoreHistory}
            onScroll={handleListScroll}
            hasMore={hasMore}
            isLoading={isLoadingMore}
          />
          {showScrollTop && (
            <button
              type="button"
              className="btn-icon scroll-top-button"
              onClick={onScrollTop}
              aria-label={t("scroll_to_top")}
              title={t("scroll_to_top")}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default AppMainContent;
