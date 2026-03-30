import { useCallback, useRef, useEffect } from "react";
import type { Dispatch, SetStateAction, MouseEvent, ReactNode } from "react";
import type { DragControls } from "framer-motion";
import ClipboardItem from "../../features/clipboard/components/ClipboardItem";
import type { ClipboardEntry } from "../types";

interface UseClipboardItemRendererOptions {
  copyToClipboard: (
    id: number,
    content: string,
    contentType: string,
    pasteWithFormat?: boolean
  ) => Promise<void>;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setRevealedIds: Dispatch<SetStateAction<Set<number>>>;
  openContent: (item: ClipboardEntry) => void;
  togglePin: (event: MouseEvent, id: number, isPinned: boolean) => void;
  deleteEntry: (event: MouseEvent, id: number) => void;
  setEditingTagsId: Dispatch<SetStateAction<number | null>>;
  tagInput: string;
  setTagInput: Dispatch<SetStateAction<string>>;
  handleUpdateTags: (id: number, tags: string[]) => void;
  t: (key: string) => string;
}

type RenderItemContent = (
  item: ClipboardEntry,
  index: number,
  dragControls?: DragControls,
  disableLayout?: boolean
) => ReactNode;

export const useClipboardItemRenderer = ({
  copyToClipboard,
  setSelectedIndex,
  setRevealedIds,
  openContent,
  togglePin,
  deleteEntry,
  setEditingTagsId,
  tagInput,
  setTagInput,
  handleUpdateTags,
  t
}: UseClipboardItemRendererOptions): { renderItemContent: RenderItemContent } => {
  // Use a ref to keep track of the latest tagInput value without triggering re-renders of the renderer itself
  const tagInputRef = useRef(tagInput);
  useEffect(() => {
    tagInputRef.current = tagInput;
  }, [tagInput]);

  const renderItemContent = useCallback(
    (item: ClipboardEntry, index: number, dragControls?: DragControls, disableLayout?: boolean) => {
      return (
        <ClipboardItem
          id={`clipboard-item-${item.id}`}
          key={item.id}
          item={item}
          index={index}
          onSelect={() => setSelectedIndex(index)}
          onCopy={(withFormat) =>
            copyToClipboard(item.id, item.content, item.content_type, withFormat)
          }
          onToggleReveal={(e) => {
            e.stopPropagation();
            setRevealedIds((prev) => {
              const next = new Set(prev);
              if (next.has(item.id)) next.delete(item.id);
              else next.add(item.id);
              return next;
            });
          }}
          onOpen={(e) => {
            e.stopPropagation();
            openContent(item);
          }}
          onTogglePin={(e) => togglePin(e, item.id, item.is_pinned)}
          onDelete={(e) => deleteEntry(e, item.id)}
          onToggleTagEditor={(e) => {
            e.stopPropagation();
            console.log('Toggling tag editor for item:', item.id);
            setEditingTagsId((prev: any) => {
              const nextId = prev === item.id ? null : item.id;
              console.log('New editing ID:', nextId);
              return nextId;
            });
          }}
          onTagInput={setTagInput}
          onTagAdd={() => {
            const tag = tagInputRef.current.trim();
            if (!tag) return;
            const currentTags = item.tags || [];
            if (currentTags.includes(tag)) {
              setTagInput("");
              return;
            }
            handleUpdateTags(item.id, [...currentTags, tag]);
            setTagInput("");
          }}
          onTagDelete={(tag) => {
            handleUpdateTags(item.id, item.tags ? item.tags.filter((t) => t !== tag) : []);
          }}
          dragControls={dragControls}
          disableLayout={disableLayout}
          t={t}
        />
      );
    },
    [
      copyToClipboard,
      setSelectedIndex,
      setRevealedIds,
      openContent,
      togglePin,
      deleteEntry,
      setEditingTagsId,
      setTagInput,
      handleUpdateTags,
      t
    ]
  );

  return { renderItemContent };
};
