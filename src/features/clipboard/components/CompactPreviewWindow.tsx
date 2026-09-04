import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
    AppWindow,
    Clock,
    Code,
    File,
    FileText,
    Image as ImageIcon,
    Link as LinkIcon,
    Video
} from "lucide-react";
import HtmlContent from "../../../shared/components/HtmlContent";
import { getConciseTime } from "../../../shared/lib/utils";
import type { CompactPreviewPayload, CompactPreviewReadyPayload } from "../lib/compactPreviewController";
import { toTauriLocalImageSrc } from "../../../shared/lib/localImageSrc";
import { getRichTextSnapshotDataUrl } from "../../../shared/lib/richTextSnapshot";

const RICH_IMAGE_FALLBACK_PREFIX = "<!--WINPASTE_RICH_IMAGE:";
const RICH_IMAGE_FALLBACK_SUFFIX = "-->";

const extractRichImageFallback = (html?: string): { cleanHtml?: string; imagePayload?: string } => {
    if (!html) return {};
    const start = html.lastIndexOf(RICH_IMAGE_FALLBACK_PREFIX);
    if (start < 0) return { cleanHtml: html };

    const markerStart = start + RICH_IMAGE_FALLBACK_PREFIX.length;
    const endRel = html.slice(markerStart).indexOf(RICH_IMAGE_FALLBACK_SUFFIX);
    if (endRel < 0) return { cleanHtml: html };

    const markerEnd = markerStart + endRel;
    const payload = html.slice(markerStart, markerEnd).trim();
    const cleanHtml = `${html.slice(0, start)}${html.slice(markerEnd + RICH_IMAGE_FALLBACK_SUFFIX.length)}`.trim();
    return {
        cleanHtml: cleanHtml || html,
        imagePayload: payload || undefined
    };
};

const resolveRichImageSrc = (payload: string): string | null => {
    const value = payload.trim();
    if (!value) return null;
    if (value.startsWith("data:image/")) return value;
    if (/^https?:\/\/asset\.localhost\//i.test(value)) return value;
    return toTauriLocalImageSrc(value);
};

const getIcon = (type: string) => {
    switch (type) {
        case "text": return <FileText size={14} />;
        case "image": return <ImageIcon size={14} />;
        case "url": return <LinkIcon size={14} />;
        case "code": return <Code size={14} />;
        case "file": return <File size={14} />;
        case "video": return <Video size={14} />;
        default: return <FileText size={14} />;
    }
};

const seekVideoPreviewFrame = (video: HTMLVideoElement | null) => {
    if (!video) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const maxSeek = Math.max(duration - 0.05, 0);
    if (maxSeek <= 0) return;
    const preferred = Math.min(duration * 0.1, 2);
    const target = Math.min(Math.max(preferred, 0.1), maxSeek);
    if (target <= 0) return;
    try {
        video.currentTime = target;
    } catch {
        // Ignore seek errors; the first frame remains a valid fallback.
    }
};

const applyTheme = (payload: CompactPreviewPayload) => {
    const root = document.documentElement;
    const body = document.body;

    root.classList.add("theme-fluent");
    body.classList.add("theme-fluent");

    if (payload.colorMode === "light") {
        root.classList.add("light-mode");
        body.classList.add("light-mode");
        root.classList.remove("dark-mode");
        body.classList.remove("dark-mode");
    } else {
        root.classList.add("dark-mode");
        body.classList.add("dark-mode");
        root.classList.remove("light-mode");
        body.classList.remove("light-mode");
    }

    body.classList.add("compact-preview");

    if (payload.clipboardItemFontSize) {
        root.style.setProperty("--clipboard-item-font-size", `${payload.clipboardItemFontSize}px`);
    }
    if (payload.clipboardTagFontSize) {
        root.style.setProperty("--clipboard-tag-font-size", `${payload.clipboardTagFontSize}px`);
    }
};

const readCssPx = (name: string, fallback: number): number => {
    const raw = document.documentElement.style.getPropertyValue(name).trim();
    const value = raw ? Number.parseFloat(raw) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
};

const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

const CompactPreviewWindow = () => {
    const [payload, setPayload] = useState<CompactPreviewPayload | null>(null);
    const [snapshotFailed, setSnapshotFailed] = useState(false);
    const [richImageFallbackFailed, setRichImageFallbackFailed] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const metaRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const dividerRef = useRef<HTMLDivElement | null>(null);
    const richSnapshotImgRef = useRef<HTMLImageElement | null>(null);
    const richSnapshotFallbackTimerRef = useRef<number | null>(null);
    const requestIdRef = useRef(0);
    const syncSeqRef = useRef(0);
    const lastEmittedSizeRef = useRef<{ width: number; height: number } | null>(null);
    const sizeSyncInFlightRef = useRef(false);

    const richImageFallbackSrc = useMemo(() => {
        if (!payload || payload.contentType !== "rich_text" || !payload.htmlContent) return null;
        const { imagePayload } = extractRichImageFallback(payload.htmlContent);
        if (!imagePayload) return null;
        return resolveRichImageSrc(imagePayload);
    }, [payload]);

    const richTextSnapshotSrc = useMemo(() => {
        if (!payload || payload.contentType !== "rich_text" || !payload.htmlContent) return null;
        if (!payload.richTextSnapshotPreview) return null;
        const { cleanHtml } = extractRichImageFallback(payload.htmlContent);
        return getRichTextSnapshotDataUrl(cleanHtml || payload.htmlContent, {
            width: 560,
            maxHeight: 1200
        });
    }, [payload]);

    const effectiveRichTextSnapshotSrc = snapshotFailed ? null : richTextSnapshotSrc;
    const effectiveRichImageFallbackSrc = richImageFallbackFailed ? null : richImageFallbackSrc;
    const useSnapshotPreviewImage = !effectiveRichImageFallbackSrc && !!effectiveRichTextSnapshotSrc;

    useEffect(() => {
        const appWindow = getCurrentWindow();
        appWindow.setAlwaysOnTop(true).catch(console.error);
        let cancelled = false;

        const initBounds = async () => {
            try {
                const monitor = await currentMonitor();
                const monitorWidth = monitor?.size.width ?? 1280;
                const monitorHeight = monitor?.size.height ?? 720;
                const scale = monitor?.scaleFactor ?? 1;
                const maxWidth = Math.max(320, Math.min(560, Math.floor((monitorWidth / scale) * 0.6)));
                const maxHeight = Math.max(240, Math.min(560, Math.floor((monitorHeight / scale) * 0.6)));
                const mediaMaxWidth = Math.max(260, Math.min(520, maxWidth));
                const mediaMaxHeight = Math.max(200, Math.min(360, maxHeight - 120));
                const minWidth = Math.max(280, Math.min(360, Math.floor(maxWidth * 0.7)));
                if (cancelled) return;

                const root = document.documentElement;
                root.style.setProperty("--preview-max-width", `${maxWidth}px`);
                root.style.setProperty("--preview-max-height", `${maxHeight}px`);
                root.style.setProperty("--preview-media-max-width", `${mediaMaxWidth}px`);
                root.style.setProperty("--preview-media-max-height", `${mediaMaxHeight}px`);
                root.style.setProperty("--preview-min-width", `${minWidth}px`);
            } catch (err) {
                console.error("Failed to initialize preview bounds:", err);
            }
        };
        void initBounds();

        const setupPromise = (async () => {
            try {
                const off = await listen<CompactPreviewPayload>("compact-preview-update", (event) => {
                    setPayload(event.payload);
                    if (event.payload.requestId) {
                        requestIdRef.current = event.payload.requestId;
                    }
                    const root = document.documentElement;
                    if (event.payload.maxWidth) {
                        root.style.setProperty("--preview-max-width", `${event.payload.maxWidth}px`);
                    }
                    if (event.payload.maxHeight) {
                        root.style.setProperty("--preview-max-height", `${event.payload.maxHeight}px`);
                    }
                    if (event.payload.mediaMaxWidth) {
                        root.style.setProperty("--preview-media-max-width", `${event.payload.mediaMaxWidth}px`);
                    }
                    if (event.payload.mediaMaxHeight) {
                        root.style.setProperty("--preview-media-max-height", `${event.payload.mediaMaxHeight}px`);
                    }
                    if (event.payload.minWidth) {
                        root.style.setProperty("--preview-min-width", `${event.payload.minWidth}px`);
                    }
                    applyTheme(event.payload);
                });
                if (cancelled) {
                    off();
                    return () => {};
                }
                emitTo("main", "compact-preview-mounted", true).catch(() => {});
                return off;
            } catch {
                return () => {};
            }
        })();

        return () => {
            cancelled = true;
            setupPromise.then((off) => off());
        };
    }, []);

    const syncWindowSize = useCallback(async (seq: number) => {
        if (syncSeqRef.current !== seq) return;
        if (sizeSyncInFlightRef.current) return;
        const container = containerRef.current;
        if (!container) return;

        const maxWidth = readCssPx("--preview-max-width", 560);
        const maxHeight = readCssPx("--preview-max-height", 560);
        // Media content shrinks to fit: a forced min-width wrapped a small
        // image in a wide card, leaving an empty band (and, placed left of the
        // item, a visible gap between the preview and the history item).
        const isMediaWindow = container.classList.contains("compact-preview-media");

        // Media sizing must not depend on the current webview width: the
        // window is created at 1x1 and a fit-content container cannot grow
        // past that, so a container-rect measurement would get stuck. The
        // intrinsic source size (img.naturalWidth / video.videoWidth) is
        // valid regardless of layout, so measure that and add the chrome.
        let mediaTarget: { width: number; height: number } | null = null;
        if (isMediaWindow) {
            const media = container.querySelector("img, video");
            const isVideo = media instanceof HTMLVideoElement;
            const nw = (media && !isVideo ? (media as HTMLImageElement).naturalWidth : isVideo ? media.videoWidth : 0) || 0;
            const nh = (media && !isVideo ? (media as HTMLImageElement).naturalHeight : isVideo ? media.videoHeight : 0) || 0;
            if (nw > 0 && nh > 0) {
                const cs = getComputedStyle(container);
                const cssPx = (raw: string) => Number.parseFloat(raw) || 0;
                const chromeX = cssPx(cs.paddingLeft) + cssPx(cs.paddingRight) + cssPx(cs.borderLeftWidth) + cssPx(cs.borderRightWidth);
                const chromeY = cssPx(cs.paddingTop) + cssPx(cs.paddingBottom) + cssPx(cs.borderTopWidth) + cssPx(cs.borderBottomWidth);
                // The CSS media box cap (--preview-media-max-width) is
                // border-box on the card: subtract the chrome so
                // imgW + chromeX never exceeds it. Otherwise the window is
                // wider than the card and a transparent band appears between
                // the card and the hovered item (only for images that hit the
                // cap — ordinary images don't).
                const boxW = Math.max(40, readCssPx("--preview-media-max-width", 520) - chromeX);
                const boxH = readCssPx("--preview-media-max-height", 360);
                const scale = Math.min(1, boxW / nw, boxH / nh);
                const imgW = Math.round(nw * scale);
                const imgH = Math.round(nh * scale);
                // The meta stays on one line; the card is at least wide enough
                // for it to be complete (matches the CSS min-width below), and
                // follows the image when the image is wider.
                const meta = metaRef.current;
                const metaH = Math.ceil(meta?.getBoundingClientRect().height ?? 20);
                const metaStyle = meta ? getComputedStyle(meta) : null;
                const metaMarginY = metaStyle
                    ? (Number.parseFloat(metaStyle.marginTop) || 0) + (Number.parseFloat(metaStyle.marginBottom) || 0)
                    : 0;
                const MEDIA_CARD_MIN_WIDTH = 260;
                mediaTarget = {
                    width: Math.max(imgW + chromeX, MEDIA_CARD_MIN_WIDTH),
                    height: metaH + metaMarginY + imgH + chromeY
                };
            }
        }

        let width: number;
        let height: number;
        if (mediaTarget) {
            width = Math.min(Math.max(mediaTarget.width, 40), maxWidth);
            height = Math.min(Math.max(mediaTarget.height, 80), maxHeight);
        } else {
            const rect = container.getBoundingClientRect();
            const logicalWidth = Math.ceil(rect.width);
            const logicalHeight = Math.ceil(rect.height);
            if (logicalWidth < 40 || logicalHeight < 40) return;
            const minWidth = isMediaWindow ? 0 : readCssPx("--preview-min-width", 320);
            width = Math.min(Math.max(logicalWidth, minWidth), maxWidth);
            height = Math.min(Math.max(logicalHeight, 80), maxHeight);
        }

        const last = lastEmittedSizeRef.current;
        if (last && Math.abs(last.width - width) <= 1 && Math.abs(last.height - height) <= 1) return;
        lastEmittedSizeRef.current = { width, height };

        sizeSyncInFlightRef.current = true;
        try {
            const appWindow = getCurrentWindow();
            await appWindow.setSize(new LogicalSize(width, height));
            await nextFrame();
            let physical = await appWindow.outerSize();
            if ((physical.width <= 2 || physical.height <= 2) && syncSeqRef.current === seq) {
                await new Promise<void>((resolve) => setTimeout(resolve, 40));
                physical = await appWindow.outerSize();
            }
            if (syncSeqRef.current !== seq) return;
            const scale = await appWindow.scaleFactor();
            const widthPx = physical.width > 2 ? physical.width : Math.max(1, Math.round(width * scale));
            const heightPx = physical.height > 2 ? physical.height : Math.max(1, Math.round(height * scale));
            const ready: CompactPreviewReadyPayload = {
                requestId: requestIdRef.current,
                width: widthPx,
                height: heightPx
            };
            emitTo("main", "compact-preview-ready", ready).catch(() => {});
        } catch {
            // The window may have been closed; the controller will recreate it.
        } finally {
            sizeSyncInFlightRef.current = false;
        }
    }, []);

    const requestResize = useCallback(() => {
        lastEmittedSizeRef.current = null;
        const seq = syncSeqRef.current;
        window.requestAnimationFrame(() => {
            if (syncSeqRef.current === seq) void syncWindowSize(seq);
        });
    }, [syncWindowSize]);

    useEffect(() => {
        if (!payload) return;
        const seq = ++syncSeqRef.current;
        lastEmittedSizeRef.current = null;

        const syncNow = () => {
            if (syncSeqRef.current !== seq) return;
            window.requestAnimationFrame(() => {
                if (syncSeqRef.current !== seq) return;
                void syncWindowSize(seq);
            });
        };

        const observer = new ResizeObserver(syncNow);
        const targets = [containerRef.current, metaRef.current, contentRef.current, dividerRef.current].filter(
            (element): element is HTMLDivElement => !!element
        );
        targets.forEach((element) => observer.observe(element));

        syncNow();
        const timerA = window.setTimeout(syncNow, 50);
        const timerB = window.setTimeout(syncNow, 180);
        const timerC = window.setTimeout(syncNow, 420);

        return () => {
            observer.disconnect();
            window.clearTimeout(timerA);
            window.clearTimeout(timerB);
            window.clearTimeout(timerC);
        };
    }, [payload, syncWindowSize]);

    useEffect(() => {
        setSnapshotFailed(false);
        setRichImageFallbackFailed(false);
    }, [payload?.content, payload?.htmlContent, payload?.richTextSnapshotPreview]);

    useEffect(() => {
        if (richSnapshotFallbackTimerRef.current) {
            window.clearTimeout(richSnapshotFallbackTimerRef.current);
            richSnapshotFallbackTimerRef.current = null;
        }
        if (!useSnapshotPreviewImage) return;

        richSnapshotFallbackTimerRef.current = window.setTimeout(() => {
            const img = richSnapshotImgRef.current;
            if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
                setSnapshotFailed(true);
            }
        }, 700);

        return () => {
            if (richSnapshotFallbackTimerRef.current) {
                window.clearTimeout(richSnapshotFallbackTimerRef.current);
                richSnapshotFallbackTimerRef.current = null;
            }
        };
    }, [useSnapshotPreviewImage, effectiveRichTextSnapshotSrc, payload?.content, payload?.htmlContent]);

    const content = useMemo(() => {
        if (!payload) return null;
        if (payload.contentType === "image") {
            const src = payload.content.startsWith("data:")
                ? payload.content
                : (toTauriLocalImageSrc(payload.content) || payload.content);
            return (
                <img
                    src={src}
                    alt="preview"
                    onLoad={requestResize}
                    style={{ width: "auto", height: "auto", borderRadius: "4px" }}
                />
            );
        }
        if (payload.contentType === "video") {
            const src = payload.content.startsWith("data:")
                ? payload.content
                : (toTauriLocalImageSrc(payload.content) || payload.content);
            return (
                <video
                    src={src}
                    preload="metadata"
                    muted
                    playsInline
                    onLoadedMetadata={(e) => {
                        seekVideoPreviewFrame(e.currentTarget);
                        requestResize();
                    }}
                    style={{ width: "auto", height: "auto", borderRadius: "4px", background: "#000" }}
                />
            );
        }
        if (payload.contentType === "rich_text" && payload.htmlContent) {
            if (effectiveRichImageFallbackSrc) {
                return (
                    <img
                        src={effectiveRichImageFallbackSrc}
                        alt="rich text preview"
                        onLoad={requestResize}
                        onError={() => setRichImageFallbackFailed(true)}
                        style={{ width: "auto", height: "auto", borderRadius: "4px" }}
                    />
                );
            }
            if (effectiveRichTextSnapshotSrc) {
                return (
                    <img
                        ref={richSnapshotImgRef}
                        src={effectiveRichTextSnapshotSrc}
                        alt="rich text snapshot preview"
                        onLoad={() => {
                            if (richSnapshotFallbackTimerRef.current) {
                                window.clearTimeout(richSnapshotFallbackTimerRef.current);
                                richSnapshotFallbackTimerRef.current = null;
                            }
                            requestResize();
                        }}
                        onError={() => {
                            if (richSnapshotFallbackTimerRef.current) {
                                window.clearTimeout(richSnapshotFallbackTimerRef.current);
                                richSnapshotFallbackTimerRef.current = null;
                            }
                            setSnapshotFailed(true);
                        }}
                        style={{ width: "100%", maxWidth: "100%", height: "auto", display: "block", borderRadius: "4px" }}
                    />
                );
            }
            const { cleanHtml } = extractRichImageFallback(payload.htmlContent);
            return (
                <HtmlContent
                    className="rich-text-preview"
                    htmlContent={cleanHtml || payload.htmlContent}
                    fallbackText={payload.preview || payload.content}
                    preview={false}
                    style={{
                        maxHeight: "none",
                        overflow: "visible",
                        fontSize: "var(--clipboard-item-font-size)",
                        lineHeight: "1.5"
                    }}
                />
            );
        }
        return payload.content || payload.preview || "";
    }, [payload, effectiveRichImageFallbackSrc, effectiveRichTextSnapshotSrc, requestResize]);

    return (
        <div className="compact-preview-root">
            <div
                ref={containerRef}
                className={`compact-popover-portal compact-preview-window theme-fluent ${payload?.contentType === "image" ? "compact-preview-image" : ""} ${payload?.contentType === "image" || payload?.contentType === "video" || !!effectiveRichImageFallbackSrc ? "compact-preview-media" : ""} ${payload?.colorMode === "light" ? "light-mode" : "dark-mode"}`}
                style={{ display: "flex", flexDirection: "column" }}
            >
                <div ref={metaRef} className="popover-meta">
                    <div className="meta-row">
                        {getIcon(payload?.contentType || "text")}
                        <span>{payload?.contentType || "text"}</span>
                    </div>
                    <div className="meta-dot">•</div>
                    <div className="meta-row">
                        <AppWindow size={14} />
                        <span>{payload?.sourceApp || "Unknown"}</span>
                    </div>
                    <div className="meta-dot">•</div>
                    <div className="meta-row">
                        <Clock size={14} />
                        <span>
                            {payload?.timestamp && payload?.language
                                ? getConciseTime(payload.timestamp, payload.language)
                                : "-"}
                        </span>
                    </div>
                </div>
                <div ref={dividerRef} className="popover-divider" />
                <div ref={contentRef} className="popover-content">{content}</div>
            </div>
        </div>
    );
};

export default CompactPreviewWindow;
