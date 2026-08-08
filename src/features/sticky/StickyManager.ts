import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import type { StickyEntry } from "../../shared/types/sticky";

const STICKY_LABEL_PREFIX = "sticky-";

let stickyCreateCounter = 0;

function labelForId(id: number): string {
    return `${STICKY_LABEL_PREFIX}${id}`;
}

function nextPosition(): { x: number; y: number } {
    // Cascading offset so new stickies don't perfectly overlap
    const col = stickyCreateCounter % 5;
    const row = Math.floor(stickyCreateCounter / 5);
    stickyCreateCounter += 1;
    return { x: 200 + col * 36, y: 200 + row * 36 };
}

export const StickyManager = {
    async createSticky(content: string, contentType: string): Promise<number | null> {
        try {
            // Check for duplicate
            const all: any[] = await invoke("get_all_stickies");
            if (all.some((e: any) => e.content === content && e.content_type === contentType)) return null;

            const pos = nextPosition();
            const entry: StickyEntry = await invoke("create_sticky", {
                content,
                contentType: contentType,
                x: pos.x,
                y: pos.y,
                width: 400,
                height: 300,
            });

            const label = labelForId(entry.id);

            const existing = await WebviewWindow.getByLabel(label);
            if (existing) await existing.close();

            // focus:false = don't steal focus on creation, but window is still focusable (normal window behavior)
            // shadow:false = we handle shadow/rounded corners in CSS
            const win = new WebviewWindow(label, {
                url: `index.html?window=sticky&id=${entry.id}`,
                decorations: false,
                transparent: true,
                resizable: true,
                skipTaskbar: true,
                alwaysOnTop: entry.always_on_top,
                visible: false,
                focus: false,
                shadow: false,
            });

            await new Promise<void>((resolve) => {
                setTimeout(async () => {
                    try {
                        await win.setPosition(new PhysicalPosition(entry.x, entry.y));
                        await win.setSize(new PhysicalSize(entry.width, entry.height));
                        await win.show();
                    } catch (e) {
                        console.error("Failed to init sticky window:", e);
                    }
                    resolve();
                }, 150);
            });

            return entry.id;
        } catch (err) {
            console.error("Failed to create sticky:", err);
            return null;
        }
    },

    async restoreAllStickies(entries: StickyEntry[]): Promise<void> {
        // Continue the cascading offset from the restored stickies so new
        // stickies don't overlap the ones restored at startup. Deleted
        // stickies leave holes in the grid, so derive the highest occupied
        // slot from the stored grid positions when possible (fall back to
        // the entry count when positions were dragged off-grid).
        let maxSlot = entries.length;
        for (const e of entries) {
            if (e.x >= 200 && e.y >= 200 && (e.x - 200) % 36 === 0 && (e.y - 200) % 36 === 0) {
                const col = Math.round((e.x - 200) / 36);
                const row = Math.round((e.y - 200) / 36);
                maxSlot = Math.max(maxSlot, row * 5 + col + 1);
            }
        }
        stickyCreateCounter = maxSlot;
        setTimeout(async () => {
            for (const entry of entries) {
                const label = labelForId(entry.id);
                const existing = await WebviewWindow.getByLabel(label);
                if (existing) continue;

                try {
                    const win = new WebviewWindow(label, {
                        url: `index.html?window=sticky&id=${entry.id}`,
                        decorations: false,
                        transparent: true,
                        resizable: true,
                        skipTaskbar: true,
                        alwaysOnTop: entry.always_on_top,
                        visible: false,
                        focus: false,
                        shadow: false,
                    });

                    setTimeout(async () => {
                        try {
                            await win.setPosition(new PhysicalPosition(entry.x, entry.y));
                            await win.setSize(new PhysicalSize(entry.width, entry.height));
                            await win.show();
                        } catch (e) {
                            console.error("Failed to restore sticky window:", e);
                        }
                    }, 150);
                } catch (err) {
                    console.error("Failed to restore sticky:", err);
                }
            }
        }, 1500);
    },

    async closeSticky(id: number): Promise<void> {
        // Close window first (resilient — ok if already gone)
        try {
            await invoke("close_sticky_window", { id });
        } catch (_) {}
        // Then delete from DB
        try {
            await invoke("delete_sticky", { id });
        } catch (_) {}
    },

    async updatePosition(id: number, x: number, y: number): Promise<void> {
        try {
            await invoke("update_sticky_position", { id, x: Math.round(x), y: Math.round(y) });
        } catch (err) {
            console.error("Failed to update sticky position:", err);
        }
    },

    async updateSize(id: number, width: number, height: number): Promise<void> {
        try {
            await invoke("update_sticky_size", { id, width: Math.round(width), height: Math.round(height) });
        } catch (err) {
            console.error("Failed to update sticky size:", err);
        }
    },

    // Errors propagate to the caller: saveDraft must NOT update the UI or
    // emit "sticky-updated" when the write failed, or the sticky window and
    // the main panel would silently show different content.
    async updateContent(id: number, content: string): Promise<void> {
        await invoke("update_sticky_content", { id, content });
    },

    async updateAlwaysOnTop(id: number, enabled: boolean): Promise<void> {
        try {
            await invoke("update_sticky_always_on_top", { id, enabled });
        } catch (err) {
            console.error("Failed to update sticky always on top:", err);
        }
    },
};
