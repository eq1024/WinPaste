import { useEffect, useState, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { ClipboardPaste, Pin, PinOff, X } from "lucide-react";
import type { StickyEntry } from "../../../shared/types/sticky";
import { StickyManager } from "../StickyManager";

function toImageSrc(content: string): string {
    if (content.startsWith("data:")) return content;
    if (content.startsWith("http://") || content.startsWith("https://")) return content;
    if (content.match(/^[A-Za-z]:[\\/]/)) {
        return `https://asset.localhost/${encodeURIComponent(content)}`;
    }
    return content;
}

export default function StickyWindow() {
    const params = new URLSearchParams(window.location.search);
    const idParam = params.get("id");
    const stickyId = idParam ? parseInt(idParam, 10) : null;

    const [entry, setEntry] = useState<StickyEntry | null>(null);
    const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false);
    const [showToolbar, setShowToolbar] = useState(false);
    const [pasteFeedback, setPasteFeedback] = useState(false);
    const [saveError, setSaveError] = useState(false);
    const saveErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Text stickies are directly editable: the draft mirrors entry.content
    // and is flushed to the DB on blur / Ctrl+Enter.
    const [draftContent, setDraftContent] = useState("");
    const toolbarTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const moveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Latest DB values, read inside the debounced handlers without re-binding
    // the native event listeners on every save.
    const entryRef = useRef<StickyEntry | null>(null);
    useEffect(() => { entryRef.current = entry; }, [entry]);

    // Apply body styling on mount — transparent, rounded, no overflow
    useEffect(() => {
        const body = document.body;
        body.style.margin = "0";
        body.style.padding = "0";
        body.style.background = "transparent";
        body.style.overflow = "hidden";
        body.style.borderRadius = "12px";
        body.classList.add("sticky-window", "theme-fluent");

        // Read theme from settings (key is "app.color_mode" in the HashMap)
        invoke<Record<string, string>>("get_settings")
            .then((settings) => {
                const mode = settings["app.color_mode"] || "dark";
                document.body.classList.add(mode === "light" ? "light-mode" : "dark-mode");
            })
            .catch(() => document.body.classList.add("dark-mode"));

        const root = document.getElementById("root");
        if (root) {
            root.style.background = "transparent";
            root.style.overflow = "hidden";
            root.style.borderRadius = "12px";
            root.style.display = "flex";
            root.style.width = "100vw";
            root.style.height = "100vh";
        }

        return () => {
            document.body.classList.remove("sticky-window", "theme-fluent", "light-mode", "dark-mode");
        };
    }, []);

    // Listen for real-time theme changes from main app
    useEffect(() => {
        const unlisten = listen<{ colorMode: string }>("theme-changed", (event) => {
            const { colorMode } = event.payload;
            document.body.classList.remove("light-mode", "dark-mode");
            document.body.classList.add(colorMode === "light" ? "light-mode" : "dark-mode");
        });
        return () => { unlisten.then((u) => u()); };
    }, []);

    // Load sticky data
    useEffect(() => {
        if (stickyId === null || isNaN(stickyId)) return;
        invoke("get_sticky", { id: stickyId })
            .then((data: any) => {
                if (data) {
                    setEntry(data);
                    setDraftContent(data.content);
                    setIsAlwaysOnTop(data.always_on_top);
                } else {
                    // Entry was deleted (e.g. clear-all left a stale window) — close self
                    emit("sticky-closed", { id: stickyId }).catch(() => {});
                    getCurrentWindow().close().catch(() => {});
                }
            })
            .catch(console.error);
    }, [stickyId]);

    // Persist window position/size via native events (debounced) — reliable
    // even when the mouse is released outside the window, unlike onMouseUp.
    useEffect(() => {
        if (stickyId === null || isNaN(stickyId)) return;
        const win = getCurrentWindow();
        const unlistenMoved = win.onMoved((event) => {
            if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
            moveTimerRef.current = setTimeout(() => {
                // Programmatic setPosition (restore/create) also fires
                // onMoved — skip the write when the position already equals
                // what we have in the DB.
                const cur = entryRef.current;
                if (cur && Math.round(cur.x) === Math.round(event.payload.x) && Math.round(cur.y) === Math.round(event.payload.y)) return;
                StickyManager.updatePosition(stickyId, event.payload.x, event.payload.y);
            }, 300);
        });
        const unlistenResized = win.onResized((event) => {
            if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
            resizeTimerRef.current = setTimeout(() => {
                const cur = entryRef.current;
                if (cur && Math.round(cur.width) === Math.round(event.payload.width) && Math.round(cur.height) === Math.round(event.payload.height)) return;
                StickyManager.updateSize(stickyId, event.payload.width, event.payload.height);
            }, 300);
        });
        return () => {
            unlistenMoved.then((u) => u());
            unlistenResized.then((u) => u());
            if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
            if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        };
    }, [stickyId]);

    // Flush the editable draft to the DB when it changed. UI state and the
    // "sticky-updated" event are only updated after a successful write — on
    // failure the draft stays in the textarea and a short error hint appears.
    const saveDraft = useCallback(async () => {
        if (stickyId === null || isNaN(stickyId)) return;
        if (!entry || entry.content === draftContent) return; // nothing changed
        try {
            await StickyManager.updateContent(stickyId, draftContent);
            setEntry((prev) => (prev ? { ...prev, content: draftContent } : prev));
            // Notify the main app so the sticky panel shows the updated content
            emit("sticky-updated", { id: stickyId }).catch(() => {});
        } catch (err) {
            console.error("Save sticky edit failed:", err);
            setSaveError(true);
            if (saveErrorTimerRef.current) clearTimeout(saveErrorTimerRef.current);
            saveErrorTimerRef.current = setTimeout(() => setSaveError(false), 3000);
        }
    }, [stickyId, entry, draftContent]);

    // Paste: copy the current (possibly just-edited) content to clipboard,
    // persist any pending edit, then hide sticky and simulate paste keystroke
    const handlePaste = useCallback(async () => {
        if (!entry || stickyId === null || isNaN(stickyId)) return;
        try {
            // First copy content to system clipboard
            await invoke("copy_to_clipboard", {
                content: draftContent,
                contentType: entry.content_type,
                paste: false,
                id: 0,
                deleteAfterUse: false,
                pasteWithFormat: false,
                moveToTop: false,
            });
            await saveDraft();
            // Then hide sticky, paste, and show again
            await invoke("paste_sticky_content", { id: stickyId });
            setPasteFeedback(true);
            setTimeout(() => setPasteFeedback(false), 300);
        } catch (err) {
            console.error("Paste failed:", err);
        }
    }, [entry, draftContent, saveDraft, stickyId]);

    const handleOpen = useCallback(async () => {
        if (!entry) return;
        try {
            await invoke("open_content", {
                content: entry.content,
                contentType: entry.content_type,
                id: 0,
            });
        } catch (err) {
            console.error("Open failed:", err);
        }
    }, [entry]);

    const toggleAlwaysOnTop = useCallback(async () => {
        if (stickyId === null || isNaN(stickyId)) return;
        const newValue = !isAlwaysOnTop;
        setIsAlwaysOnTop(newValue);
        await getCurrentWindow().setAlwaysOnTop(newValue);
        await StickyManager.updateAlwaysOnTop(stickyId, newValue);
    }, [stickyId, isAlwaysOnTop]);

    const handleClose = useCallback(async () => {
        if (stickyId !== null && !isNaN(stickyId)) {
            // Delete first, then notify the main app so its list refresh
            // does not race with (and show) a stale entry
            try { await invoke("delete_sticky", { id: stickyId }); } catch (_) {}
            emit("sticky-closed", { id: stickyId }).catch(() => {});
            try { await invoke("close_sticky_window", { id: stickyId }); } catch (_) {}
        }
        try { await getCurrentWindow().close(); } catch (_) {}
    }, [stickyId]);

    const handleMouseEnter = useCallback(() => {
        if (toolbarTimer.current) clearTimeout(toolbarTimer.current);
        setShowToolbar(true);
    }, []);

    const handleMouseLeave = useCallback(() => {
        toolbarTimer.current = setTimeout(() => setShowToolbar(false), 600);
    }, []);

    const handleTextKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && e.ctrlKey) {
            e.preventDefault();
            saveDraft();
        }
    }, [saveDraft]);

    if (!entry) {
        return (
            <div style={{
                width: "100vw", height: "100vh",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "transparent",
            }}>
                <div style={{
                    width: 32, height: 32,
                    border: "3px solid rgba(128,128,128,0.2)",
                    borderTopColor: "var(--accent-color, #0078d4)",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                }} />
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
        );
    }

    const isImage = entry.content_type === "image";
    const btnBase = {
        width: 24, height: 24,
        border: "none", borderRadius: 4,
        background: "var(--bg-button, rgba(128,128,128,0.1))",
        color: "var(--text-secondary, #666)",
        cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14,
        lineHeight: 1,
    };

    return (
        <div
            className="sticky-container"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            style={{
                width: "100vw",
                height: "100vh",
                margin: 0,
                padding: 0,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                borderRadius: 12,
                boxShadow: "0 4px 24px rgba(0,0,0,0.30)",
                border: "1px solid var(--line-soft, rgba(128,128,128,0.15))",
                backgroundColor: "var(--bg-window, #ffffff)",
            }}
        >
            <div
                style={{
                    position: "absolute",
                    top: 0, left: 0, right: 0, height: 36,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    padding: "4px 6px",
                    gap: 4,
                    opacity: showToolbar ? 1 : 0,
                    transition: "opacity 0.2s",
                    background: showToolbar
                        ? "linear-gradient(to bottom, rgba(0,0,0,0.06), transparent)"
                        : "transparent",
                    zIndex: 10,
                }}
                onMouseDown={(e) => {
                    if (e.button === 0 && e.target === e.currentTarget) {
                        getCurrentWindow().startDragging().catch(() => {});
                    }
                }}
            >
                <button className="sticky-toolbar-btn" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); handlePaste(); }} title="粘贴到光标处" style={{ ...btnBase, color: pasteFeedback ? "var(--accent-color, #0078d4)" : btnBase.color }}><ClipboardPaste size={14} /></button>
                <button className="sticky-toolbar-btn" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); toggleAlwaysOnTop(); }} title={isAlwaysOnTop ? "取消置顶" : "置顶"} style={{ ...btnBase, background: isAlwaysOnTop ? "var(--accent-color, #0078d4)" : btnBase.background, color: isAlwaysOnTop ? "#fff" : btnBase.color }}>{isAlwaysOnTop ? <PinOff size={14} /> : <Pin size={14} />}</button>
                <button className="sticky-toolbar-btn" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); handleClose(); }} title="关闭" style={btnBase}><X size={14} /></button>
            </div>

            <div
                className="sticky-content"
                style={{
                    flex: 1, overflow: "hidden",
                    padding: "40px 12px 12px 12px",
                    display: "flex",
                    alignItems: isImage ? "center" : "flex-start",
                    justifyContent: isImage ? "center" : "flex-start",
                }}
                onDoubleClick={() => (isImage ? handleOpen() : undefined)}
            >
                {isImage ? (
                    <img src={toImageSrc(entry.content)} alt="Sticky" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 6, userSelect: "none", pointerEvents: "none" }} draggable={false} />
                ) : (
                    // Text stickies are directly editable — changes are persisted on blur / Ctrl+Enter
                    <textarea
                        value={draftContent}
                        onChange={(e) => setDraftContent(e.target.value)}
                        onKeyDown={handleTextKeyDown}
                        onBlur={saveDraft}
                        spellCheck={false}
                        style={{
                            flex: 1,
                            width: "100%",
                            height: "100%",
                            border: "none",
                            outline: "none",
                            resize: "none",
                            background: "transparent",
                            overflow: "auto",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            fontSize: 14,
                            lineHeight: 1.6,
                            fontFamily: "inherit",
                            color: "var(--text-primary, #1a1a1a)",
                            padding: 0,
                        }}
                    />
                )}
            </div>

            {saveError && (
                <div style={{
                    position: "absolute",
                    bottom: 10, left: 12, right: 12,
                    padding: "6px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    background: "rgba(200, 60, 60, 0.12)",
                    border: "1px solid rgba(200, 60, 60, 0.35)",
                    color: "var(--text-error, #c0392b)",
                    textAlign: "center",
                }}>
                    保存失败，内容未写入
                </div>
            )}
        </div>
    );
}
