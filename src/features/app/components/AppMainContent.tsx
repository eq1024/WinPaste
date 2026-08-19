import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, RefObject, ReactNode } from "react";
import { motion, Reorder, useDragControls, AnimatePresence } from "framer-motion";
import type { DragControls } from "framer-motion";
import { ArrowUp, Clipboard, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import type { StickyEntry } from "../../../shared/types/sticky";
import { StickyManager } from "../../sticky/StickyManager";
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
  stickyEntries?: StickyEntry[];
  onStickyRemoved?: () => void;
  stickyEnabled?: boolean;
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
        paddingTop: isFirst ? "4px" : undefined,
        paddingBottom: "4px", /* match unpinned spacing roughly */
        width: "calc(100% - 12px)"
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
  onScrollTop,
  stickyEntries,
  onStickyRemoved,
  stickyEnabled
}: AppMainContentProps) => {
  const {
    showSettings,
    showTagManager,
    tagManagerEnabled,
  } = useUIStore();

  const {
    compactMode,
    pinnedCollapsed,
    settingsLoaded,
    settingsLoadError,
  } = useSettingsStore();

  const {
    search,
    hasMore,
    isLoadingMore
  } = useHistoryStore();

  const [pinnedOrderIds, setPinnedOrderIds] = useState<number[]>(
    () => pinnedItems.map((item) => item.id)
  );
  const pinnedOrderRef = useRef<number[]>(pinnedItems.map((item) => item.id));
  const [isDraggingPinned, setIsDraggingPinned] = useState(false);
  const [isPinnedExpanded, setIsPinnedExpanded] = useState(false);
  const [isStickyExpanded, setIsStickyExpanded] = useState(false);

  const hasStickies = stickyEnabled && stickyEntries && stickyEntries.length > 0;

  // 面板关闭时重置折叠状态，每次唤出都是折叠的
  useEffect(() => {
    const unlisten = listen("window-hidden", () => {
      setIsPinnedExpanded(false);
    });
    return () => { unlisten.then(fn => fn()).catch(() => {}); };
  }, []);

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
    <AnimatePresence mode="popLayout">
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
          {settingsLoaded ? (
            <SettingsPanel {...settingsPanelProps} />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                minHeight: 180,
                color: "var(--text-secondary)",
                fontSize: 12,
                textAlign: "center",
                padding: "0 16px",
              }}
            >
              {settingsLoadError ? t("settings_load_failed") : t("settings_loading")}
            </div>
          )}
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
            header={
              <div style={{ marginBottom: (hasStickies || pinnedItems.length > 0) ? 8 : 0 }}>
                {hasStickies && (
                  <div style={{ marginBottom: pinnedItems.length > 0 ? 6 : 0 }}>
                    <div
                      onClick={() => setIsStickyExpanded(!isStickyExpanded)}
                      style={{ padding: "6px 12px", fontSize: "11px", fontWeight: "bold", color: "var(--text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", userSelect: "none",'marginBottom': '10px' }}
                    >
                      <span style={{ transform: isStickyExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', display: 'inline-block' }}>▶</span>
                      {t('sticky_title') || '贴图记录'} ({stickyEntries!.length})
                    </div>
                    {isStickyExpanded && (
                      <div style={{ padding: "0 0 4px 0", display: "flex", flexDirection: "column", gap: "4px" }}>
                        {stickyEntries!.map((entry) => (
                          <div key={entry.id} style={{ width: "calc(100% - 12px)", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderRadius: 6, background: "var(--bg-element)", fontSize: 12, color: "var(--text-secondary)" }}>
                            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              [{entry.content_type === "image" ? "图片" : "文字"}] {entry.content_type === "image" ? "" : (entry.content?.substring(0, 40) + (entry.content?.length > 40 ? "..." : ""))}
                            </span>
                            <button
                              className="btn-icon"
                              onClick={async (e) => {
                                e.stopPropagation();
                                await StickyManager.closeSticky(entry.id);
                                onStickyRemoved?.();
                              }}
                              title="取消贴图"
                              style={{ width: 24, height: 24, minWidth: 24 }}
                            ><X size={14} /></button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {pinnedItems.length > 0 ? (
                pinnedCollapsed ? (
                  <div style={{ marginBottom: "8px" }}>
                    <div
                      onClick={() => setIsPinnedExpanded(!isPinnedExpanded)}
                      style={{
                        padding: "6px 12px",
                        fontSize: "11px",
                        fontWeight: "bold",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        userSelect: "none"
                      }}
                    >
                      <span style={{ transform: isPinnedExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', display: 'inline-block' }}>▶</span>
                      {t('pinned_items_title') || '置顶记录'} ({pinnedItems.length})
                    </div>
                    {isPinnedExpanded && (
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
                    )}
                  </div>
                ) : (
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
                )
              ) : null}
              </div>
            }
            renderItem={(item, index, isFirst?: boolean) => {
              const absoluteIndex = pinnedItems.length + index;
              const el = renderItemContent(item, absoluteIndex, undefined, true);
              if (isFirst && (pinnedItems.length === 0 || pinnedCollapsed)) {
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
