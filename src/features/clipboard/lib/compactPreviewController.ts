import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
    PhysicalPosition,
    PhysicalSize,
    currentMonitor,
    getCurrentWindow,
    monitorFromPoint
} from "@tauri-apps/api/window";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Locale } from "../../../shared/types";

export type CompactPreviewPayload = {
    contentType: string;
    content: string;
    preview?: string;
    htmlContent?: string;
    sourceApp?: string;
    timestamp?: number;
    language?: Locale;
    theme?: string;
    colorMode?: "light" | "dark";
    richTextSnapshotPreview?: boolean;
    clipboardItemFontSize?: number;
    clipboardTagFontSize?: number;
    maxWidth?: number;
    maxHeight?: number;
    mediaMaxWidth?: number;
    mediaMaxHeight?: number;
    minWidth?: number;
    requestId?: number;
};

export type CompactPreviewReadyPayload = {
    requestId: number;
    width: number;
    height: number;
};

export type CompactPreviewAnchor = {
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
    itemRect: {
        left: number;
        top: number;
        width: number;
        height: number;
    };
};

type PhysicalRect = {
    left: number;
    top: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
};

type PlacementArea = PhysicalRect;

const PREVIEW_WINDOW_LABEL = "compact-preview";
const MOUNT_TIMEOUT_MS = 2500;
const READY_TIMEOUT_MS = 2000;
const LIFE_CYCLE_EVENTS = ["tauri://hide", "tauri://close-requested", "tauri://destroyed", "window-hidden"];

const setIgnoreBlurSafe = (ignore: boolean) => {
    invoke("set_ignore_blur", { ignore }).catch(() => {});
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const computePreviewPlacement = (
    anchor: PhysicalRect,
    preview: { width: number; height: number },
    area: PlacementArea,
    gap: number,
    margin: number
): { x: number; y: number; placement: "left" | "right" | "top" | "bottom" } => {
    // Floating-UI style placement: prefer sides, flip to the other side, then fall back vertically.
    const minX = area.left + margin;
    const minY = area.top + margin;
    const maxX = area.right - margin;
    const maxY = area.bottom - margin;

    const clampX = (x: number) => clamp(x, minX, maxX);
    const clampY = (y: number) => clamp(y, minY, maxY);
    const fits = (x: number, y: number) =>
        x >= minX && y >= minY && x + preview.width <= maxX && y + preview.height <= maxY;

    const centerX = clampX(anchor.left + Math.round((anchor.width - preview.width) / 2));
    const centerY = clampY(anchor.top + Math.round((anchor.height - preview.height) / 2));
    const rightSpace = area.right - anchor.right;
    const leftSpace = anchor.left - area.left;
    const bottomSpace = area.bottom - anchor.bottom;
    const topSpace = anchor.top - area.top;

    const primaryHorizontal: "left" | "right" = rightSpace >= leftSpace ? "right" : "left";
    const secondaryHorizontal: "left" | "right" = primaryHorizontal === "right" ? "left" : "right";
    const primaryVertical: "bottom" | "top" = bottomSpace >= topSpace ? "bottom" : "top";
    const secondaryVertical: "bottom" | "top" = primaryVertical === "bottom" ? "top" : "bottom";

    const horizontalCandidate = (placement: "left" | "right") => ({
        placement,
        x:
            placement === "right"
                ? anchor.right + gap
                : anchor.left - preview.width - gap,
        y: centerY
    });

    const verticalCandidate = (placement: "bottom" | "top") => ({
        placement,
        x: centerX,
        y:
            placement === "bottom"
                ? anchor.bottom + gap
                : anchor.top - preview.height - gap
    });

    const candidates = [
        horizontalCandidate(primaryHorizontal),
        horizontalCandidate(secondaryHorizontal),
        verticalCandidate(primaryVertical),
        verticalCandidate(secondaryVertical)
    ];

    for (const candidate of candidates) {
        if (fits(candidate.x, candidate.y)) return candidate;
    }

    const fallback = candidates[0];
    return {
        ...fallback,
        x: clampX(fallback.x),
        y: clampY(fallback.y)
    };
};

class CompactPreviewController {
    private ignoreBlurActive = false;
    private window: WebviewWindow | null = null;
    private creating = false;
    private creationPromise: Promise<WebviewWindow | null> | null = null;
    private mounted = false;
    private mountedPromise: Promise<boolean> | null = null;
    private mountedWaiters: Array<(ok: boolean) => void> = [];
    private mountedListenerPromise: Promise<UnlistenFn | null> | null = null;
    private listenersReady: Promise<void> | null = null;
    private readyListenerPromise: Promise<UnlistenFn | null> | null = null;
    private pending: { anchor: CompactPreviewAnchor; generation: number } | null = null;
    private generation = 0;
    private requestSeq = 0;
    private readyRequestId = 0;
    private readyWaiters = new Map<number, { resolve: (size: { width: number; height: number } | null) => void }>();
    private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    private setIgnoreBlur(ignore: boolean) {
        if (this.ignoreBlurActive === ignore) return;
        this.ignoreBlurActive = ignore;
        setIgnoreBlurSafe(ignore);
    }

    private async ensureMountedListener(): Promise<void> {
        if (this.mounted || this.mountedListenerPromise) return;
        this.mountedListenerPromise = listen("compact-preview-mounted", () => {
            this.mounted = true;
            const waiters = this.mountedWaiters.splice(0);
            waiters.forEach((resolve) => resolve(true));
        })
            .then((unlisten) => unlisten)
            .catch(() => null);
        await this.mountedListenerPromise;
    }

    private async ensureReadyListener(): Promise<void> {
        if (this.readyListenerPromise) return;
        this.readyListenerPromise = (async () => {
            const unlisteners: UnlistenFn[] = [];
            try {
                const offReady = await listen<CompactPreviewReadyPayload>("compact-preview-ready", (event) => {
                    const payload = event.payload;
                    if (!payload || payload.width <= 0 || payload.height <= 0) return;
                    this.acceptSize(payload.requestId, { width: payload.width, height: payload.height });
                });
                unlisteners.push(offReady);
            } catch {
                // Ignore listener failures; the controller falls back to the legacy event below.
            }
            try {
                const offLegacy = await listen<{ width: number; height: number }>("compact-preview-resize", (event) => {
                    const payload = event.payload;
                    if (!payload || payload.width <= 0 || payload.height <= 0) return;
                    this.acceptSize(this.readyRequestId, { width: payload.width, height: payload.height });
                });
                unlisteners.push(offLegacy);
            } catch {
                // Ignore listener failures.
            }
            return () => unlisteners.forEach((off) => off());
        })();
        await this.readyListenerPromise;
    }

    private acceptSize(requestId: number, size: { width: number; height: number }) {
        if (requestId !== this.readyRequestId) return;

        const waiter = this.readyWaiters.get(requestId);
        if (waiter) {
            this.readyWaiters.delete(requestId);
            waiter.resolve(size);
            return;
        }

        const pending = this.pending;
        if (pending && pending.generation === this.generation) {
            void this.placeAndShow(pending.anchor, size, pending.generation).catch(() => {});
        }
    }

    private async ensureLifecycleListeners(): Promise<void> {
        if (this.listenersReady) return this.listenersReady;
        this.listenersReady = (async () => {
            await Promise.all(
                LIFE_CYCLE_EVENTS.map(async (eventName) => {
                    try {
                        await listen(
                            eventName,
                            () => {
                                void this.hide();
                            },
                            { target: { kind: "Window", label: "main" } }
                        );
                    } catch {
                        // The window may already be closed; ignore listener failures.
                    }
                })
            );
        })();
        await this.listenersReady;
    }

    private async tryReuseExistingWindow(): Promise<WebviewWindow | null> {
        try {
            const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
            const existing = await WebviewWindow.getByLabel(PREVIEW_WINDOW_LABEL);
            if (!existing) return null;
            this.window = existing;
            this.mounted = true;
            this.mountedPromise = Promise.resolve(true);
            try { await existing.setIgnoreCursorEvents(true); } catch {}
            try { await existing.setAlwaysOnTop(true); } catch {}
            return existing;
        } catch {
            return null;
        }
    }

    private async recreatePreviewWindow(): Promise<WebviewWindow | null> {
        const old = this.window;
        if (old) {
            try { await old.destroy(); } catch {}
        }
        this.window = null;
        this.mounted = false;
        this.mountedPromise = null;
        return this.ensureWindow();
    }

    private async ensureWindow(): Promise<WebviewWindow | null> {
        if (this.window) return this.window;
        if (this.creationPromise) return this.creationPromise;
        if (this.creating) return null;

        this.creating = true;
        this.creationPromise = (async () => {
            try {
                const reused = await this.tryReuseExistingWindow();
                if (reused) return reused;

                const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
                const previewWindow = new WebviewWindow(PREVIEW_WINDOW_LABEL, {
                    url: "index.html?window=compact-preview",
                    decorations: false,
                    transparent: true,
                    resizable: false,
                    skipTaskbar: true,
                    alwaysOnTop: true,
                    visible: false,
                    focus: false,
                    focusable: false,
                    shadow: false
                });
                this.window = previewWindow;
                this.mounted = false;
                this.mountedPromise = null;

                const created = await new Promise<boolean>((resolve) => {
                    const timeout = setTimeout(() => resolve(false), MOUNT_TIMEOUT_MS);
                    previewWindow.once("tauri://created", () => {
                        clearTimeout(timeout);
                        resolve(true);
                    });
                    previewWindow.once("tauri://error", () => {
                        clearTimeout(timeout);
                        resolve(false);
                    });
                });

                if (!created) {
                    this.window = null;
                    const reusedAfterFailure = await this.tryReuseExistingWindow();
                    if (reusedAfterFailure) return reusedAfterFailure;
                    return null;
                }

                try { await previewWindow.setSize(new PhysicalSize(1, 1)); } catch {}
                try { await previewWindow.setIgnoreCursorEvents(true); } catch {}
                try { await previewWindow.setAlwaysOnTop(true); } catch {}
                return previewWindow;
            } catch {
                this.window = null;
                return null;
            } finally {
                this.creating = false;
                this.creationPromise = null;
            }
        })();
        return this.creationPromise;
    }

    private waitForMounted(): Promise<boolean> {
        if (this.mounted) return Promise.resolve(true);
        if (this.mountedPromise) return this.mountedPromise;
        this.mountedPromise = new Promise<boolean>((resolve) => {
            let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                const waiters = this.mountedWaiters.splice(0);
                waiters.forEach((waiter) => waiter(false));
                this.mountedPromise = null;
            }, MOUNT_TIMEOUT_MS);
            this.mountedWaiters.push((ok) => {
                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }
                resolve(ok);
            });
        });
        return this.mountedPromise;
    }

    private waitForReady(
        requestId: number,
        timeoutMs: number = READY_TIMEOUT_MS
    ): Promise<{ width: number; height: number } | null> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.readyWaiters.delete(requestId);
                resolve(null);
            }, timeoutMs);
            this.readyWaiters.set(requestId, {
                resolve: (size) => {
                    clearTimeout(timeout);
                    resolve(size);
                }
            });
        });
    }

    private async resolveAnchorPhysical(
        anchor: CompactPreviewAnchor,
        scale: number,
        appWindow: ReturnType<typeof getCurrentWindow>
    ): Promise<PhysicalRect> {
        // getBoundingClientRect is CSS px; Tauri position/size APIs are physical px.
        const width = Math.max(1, Math.round(anchor.itemRect.width * scale));
        const height = Math.max(1, Math.round(anchor.itemRect.height * scale));

        try {
            const inner = await appWindow.innerPosition();
            const left = Math.round(inner.x + anchor.itemRect.left * scale);
            const top = Math.round(inner.y + anchor.itemRect.top * scale);
            return { left, top, width, height, right: left + width, bottom: top + height };
        } catch {
            try {
                const outer = await appWindow.outerPosition();
                const left = Math.round(outer.x + anchor.itemRect.left * scale);
                const top = Math.round(outer.y + anchor.itemRect.top * scale);
                return { left, top, width, height, right: left + width, bottom: top + height };
            } catch {
                const left = Math.round((anchor.screenX - anchor.clientX + anchor.itemRect.left) * scale);
                const top = Math.round((anchor.screenY - anchor.clientY + anchor.itemRect.top) * scale);
                return { left, top, width, height, right: left + width, bottom: top + height };
            }
        }
    }

    private async findAnchorMonitor(anchor: PhysicalRect) {
        try {
            const monitor = await monitorFromPoint(
                Math.round(anchor.left + anchor.width / 2),
                Math.round(anchor.top + anchor.height / 2)
            );
            if (monitor) return monitor;
        } catch {
            // Fall through to currentMonitor below.
        }
        return currentMonitor();
    }

    private async placeAndShow(
        anchor: CompactPreviewAnchor,
        size: { width: number; height: number },
        generation: number
    ): Promise<void> {
        const previewWindow = this.window;
        if (!previewWindow || generation !== this.generation || !this.pending) return;

        const appWindow = getCurrentWindow();
        const scale = await appWindow.scaleFactor();
        const anchorRect = await this.resolveAnchorPhysical(anchor, scale, appWindow);
        const monitor = await this.findAnchorMonitor(anchorRect);
        const rawWorkArea = monitor?.workArea ?? monitor;
        if (!rawWorkArea || generation !== this.generation || !this.pending) return;

        const gap = Math.max(6, Math.round(8 * scale));
        const margin = Math.max(8, Math.round(12 * scale));
        const area: PlacementArea = {
            left: rawWorkArea.position.x,
            top: rawWorkArea.position.y,
            width: rawWorkArea.size.width,
            height: rawWorkArea.size.height,
            right: rawWorkArea.position.x + rawWorkArea.size.width,
            bottom: rawWorkArea.position.y + rawWorkArea.size.height
        };
        const target = computePreviewPlacement(anchorRect, size, area, gap, margin);

        this.setIgnoreBlur(true);
        try {
            await previewWindow.setPosition(new PhysicalPosition(target.x, target.y));
            if (generation !== this.generation || !this.pending) {
                this.setIgnoreBlur(false);
                return;
            }
            await previewWindow.show();
            try { await previewWindow.setSize(new PhysicalSize(size.width, size.height)); } catch {}
            try { await previewWindow.setAlwaysOnTop(true); } catch {}
        } catch (err) {
            this.setIgnoreBlur(false);
            throw err;
        }
    }

    private async showDefaultFallback(anchor: CompactPreviewAnchor, generation: number) {
        if (generation !== this.generation || !this.pending || !this.window) return;
        try {
            const appWindow = getCurrentWindow();
            const scale = await appWindow.scaleFactor();
            await this.placeAndShow(anchor, {
                width: Math.max(1, Math.round(320 * scale)),
                height: Math.max(1, Math.round(220 * scale))
            }, generation);
        } catch {
            // The next ready event will reposition once the preview reports its real size.
        }
    }

    async show(anchor: CompactPreviewAnchor, payload: CompactPreviewPayload): Promise<void> {
        const generation = ++this.generation;
        const requestId = ++this.requestSeq;
        this.pending = { anchor, generation };
        this.readyRequestId = requestId;
        this.fallbackTimer = setTimeout(() => {
            void this.showDefaultFallback(anchor, generation);
        }, 2500);

        await this.ensureMountedListener();
        await this.ensureReadyListener();
        await this.ensureLifecycleListeners();

        const previewWindow = await this.ensureWindow();
        if (!previewWindow || generation !== this.generation || !this.pending) return;

        await this.waitForMounted();
        if (generation !== this.generation || !this.pending) return;

        const appWindow = getCurrentWindow();
        const scale = await appWindow.scaleFactor();
        const anchorRect = await this.resolveAnchorPhysical(anchor, scale, appWindow);
        const monitor = await this.findAnchorMonitor(anchorRect);
        const rawWorkArea = monitor?.workArea ?? monitor;
        const boundsPayload: Partial<CompactPreviewPayload> = {};
        if (rawWorkArea) {
            const maxWidth = Math.max(320, Math.min(560, Math.floor((rawWorkArea.size.width / scale) * 0.6)));
            const maxHeight = Math.max(240, Math.min(560, Math.floor((rawWorkArea.size.height / scale) * 0.6)));
            const mediaMaxWidth = Math.max(260, Math.min(520, maxWidth));
            const mediaMaxHeight = Math.max(200, Math.min(360, maxHeight - 120));
            const minWidth = Math.max(280, Math.min(360, Math.floor(maxWidth * 0.7)));
            Object.assign(boundsPayload, {
                maxWidth,
                maxHeight,
                mediaMaxWidth,
                mediaMaxHeight,
                minWidth
            });
        }

        const sizePromise = this.waitForReady(requestId, 700);
        try {
            await previewWindow.emit("compact-preview-update", {
                ...payload,
                ...boundsPayload,
                requestId
            });
        } catch {
            this.window = null;
            this.mounted = false;
            this.mountedPromise = null;
            return;
        }

        const size = await sizePromise;
        if (this.fallbackTimer) {
            clearTimeout(this.fallbackTimer);
            this.fallbackTimer = null;
        }
        if (!size && generation === this.generation && this.pending) {
            // A reused window may still be running the old preview protocol.
            // Recreate it once so the new component gets a chance to report its size.
            const freshWindow = await this.recreatePreviewWindow();
            if (freshWindow && generation === this.generation && this.pending) {
                await this.waitForMounted();
                if (generation !== this.generation || !this.pending) return;
                const retryRequestId = ++this.requestSeq;
                this.readyRequestId = retryRequestId;
                const retryPromise = this.waitForReady(retryRequestId, 1500);
                try {
                    await freshWindow.emit("compact-preview-update", {
                        ...payload,
                        ...boundsPayload,
                        requestId: retryRequestId
                    });
                } catch {
                    // Fall through to the default-size fallback below.
                }
                const retrySize = await retryPromise;
                if (retrySize && generation === this.generation && this.pending) {
                    try {
                        await this.placeAndShow(anchor, retrySize, generation);
                    } catch {
                        this.window = null;
                        this.mounted = false;
                        this.mountedPromise = null;
                    }
                    return;
                }
            }
            // The hidden preview window can report 0/1 physical px on some WebView2
            // versions. Show a sane default first, then let the next ready event
            // reposition once the real size is known.
            try {
                await this.placeAndShow(anchor, {
                    width: Math.max(1, Math.round(320 * scale)),
                    height: Math.max(1, Math.round(220 * scale))
                }, generation);
            } catch {
                this.window = null;
                this.mounted = false;
                this.mountedPromise = null;
            }
            return;
        }
        if (!size || generation !== this.generation || !this.pending) return;
        try {
            await this.placeAndShow(anchor, size, generation);
        } catch {
            this.window = null;
            this.mounted = false;
            this.mountedPromise = null;
        }
    }

    async hide(): Promise<void> {
        this.generation++;
        this.pending = null;
        if (this.fallbackTimer) {
            clearTimeout(this.fallbackTimer);
            this.fallbackTimer = null;
        }
        for (const waiter of this.readyWaiters.values()) {
            waiter.resolve(null);
        }
        this.readyWaiters.clear();
        this.setIgnoreBlur(false);

        const previewWindow = this.window;
        if (!previewWindow) return;
        try {
            await previewWindow.hide();
        } catch {
            // The window may already be gone; the next show will recreate it.
        }
    }
}

export const compactPreviewController = new CompactPreviewController();
