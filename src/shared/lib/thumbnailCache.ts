// Recent thumbnails streamed by the backend AFTER the list was already
// rendered (list payloads carry only placeholders for base64 images; the
// multi-MB full image is decoded in the background and the small thumbnail is
// pushed via the "clipboard-thumbnail" event).
//
// Two consumers:
// - App.tsx patches the history store on the event, so visible items
//   re-render with the thumbnail;
// - ClipboardItem reads this cache as a fallback, so items that are inserted
//   into the list AFTER the event fired (e.g. search results arriving late)
//   still find their thumbnail.
const recentThumbs = new Map<number, string>();

export const peekRecentThumb = (id: number): string | undefined => recentThumbs.get(id);

export const storeRecentThumb = (id: number, preview: string): void => {
  if (recentThumbs.size > 512) recentThumbs.clear();
  recentThumbs.set(id, preview);
};
