import { useRef, useEffect, useState, useMemo, memo } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { compactPreviewController } from "../lib/compactPreviewController";
import type { CompactPreviewAnchor } from "../lib/compactPreviewController";
import {
    Pin,
    PinOff,
    Eye,
    EyeOff,
    ExternalLink,
    Tag,
    X,
    FileText,
    Image as ImageIcon,
    Link as LinkIcon,
    Code,
    File,
    Plus,
    Video,
    FileArchive,
    Music,
    FileCode,
    Cpu,
    Files,
    ImageOff,
    FileQuestion,
    GripVertical,
    StickyNote
} from "lucide-react";
import { motion } from "framer-motion";
import type { ClipboardItemProps } from "../types";
import { getConciseTime, getTagColor } from "../../../shared/lib/utils";
import HtmlContent from "../../../shared/components/HtmlContent";
import { toTauriLocalImageSrc } from "../../../shared/lib/localImageSrc";
import { getRichTextSnapshotDataUrl } from "../../../shared/lib/richTextSnapshot";
import { getFileIcon as getFileIconDataUrl, peekFileIcon } from "../../../shared/lib/fileIcon";
import { getSourceAppIcon, peekSourceAppIcon } from "../../../shared/lib/sourceAppIcon";
import { useSettingsStore } from "../../../shared/store/settingsStore";
import { useHistoryStore } from "../../../shared/store/historyStore";
import { useUIStore } from "../../../shared/store/uiStore";

const RICH_IMAGE_FALLBACK_PREFIX = "<!--WINPASTE_RICH_IMAGE:";
const RICH_IMAGE_FALLBACK_SUFFIX = "-->";
const EXTERNAL_CHECK_TTL_MS = 10_000;
const externalCheckCache = new Map<number, number>();

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

const resolveRichImageSrc = (payload?: string): string | null => {
    if (!payload) return null;
    const value = payload.trim();
    if (!value) return null;
    if (value.startsWith("data:image/")) return value;
    if (/^https?:\/\/asset\.localhost\//i.test(value)) return value;
    return toTauriLocalImageSrc(value);
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
    try { video.currentTime = target; } catch {}
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

const renderSourceAppIcon = (iconSrc: string | null, contentType: string, sourceApp: string) => {
    if (!iconSrc) return getIcon(contentType);
    return <img src={iconSrc} alt={`${sourceApp} icon`} className="source-app-icon" loading="lazy" />;
};

const getFallbackFileIcon = (filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'zip': case 'rar': case '7z': case 'tar': case 'gz': return <FileArchive size={20} />;
        case 'mp3': case 'wav': case 'flac': case 'm4a': return <Music size={20} />;
        case 'exe': case 'msi': case 'bat': case 'sh': return <Cpu size={20} />;
        case 'pdf': case 'doc': case 'docx': case 'ppt': case 'pptx': case 'xls': case 'xlsx': return <FileText size={20} />;
        case 'js': case 'ts': case 'tsx': case 'jsx': case 'py': case 'rs': case 'c': case 'cpp': case 'go': case 'java': case 'html': case 'css': case 'json': return <FileCode size={20} />;
        default: return <File size={20} />;
    }
};

const ClipboardItem = ({
    item,
    index,
    onSelect,
    onCopy,
    onToggleReveal,
    onOpen,
    onTogglePin,
    onDelete,
    onToggleTagEditor,
    onTagInput,
    onTagAdd,
    onTagDelete,
    onStickyCreate,
    dragControls,
    id,
    disableLayout,
    t,
    onExternalMissing
}: ClipboardItemProps & { t: (key: string) => string }) => {
    const { language, richTextSnapshotPreview, showSourceAppIcon, compactMode, privacyProtection, autoHideTags, colorMode, clipboardItemFontSize, clipboardTagFontSize } = useSettingsStore();
    const { tagInput, revealedIds, editingTagsId } = useHistoryStore();
    const windowShowTick = useUIStore((s) => s.windowShowTick);
    const isSelected = useHistoryStore(s => s.isKeyboardMode && index === s.selectedIndex);

    const isSensitiveHidden = privacyProtection && (item.tags?.includes('sensitive') || item.tags?.includes('密码') || item.tags?.includes('password')) && !revealedIds.has(item.id);
    const isRevealed = revealedIds.has(item.id);
    const isEditingTags = editingTagsId === item.id;

    const tagInputRef = useRef<HTMLInputElement>(null);
    const [localTagInput, setLocalTagInput] = useState(tagInput);
    const [snapshotFailed, setSnapshotFailed] = useState(false);
    const [richImageFallbackFailed, setRichImageFallbackFailed] = useState(false);
    const [sourceAppIcon, setSourceAppIcon] = useState<string | null>(() => peekSourceAppIcon(item.source_app_path) ?? null);
    const itemRef = useRef<HTMLDivElement | null>(null);
    
    const filePaths = useMemo(() => item.content_type === "file" ? item.content.split('\n').filter(path => path.trim()) : [], [item.content, item.content_type]);
    // Image-file thumbnails for multi-file selections: when every selected
    // file is an image we render a thumbnail strip instead of the plain
    // "N items" card.
    // Keep in sync with the Rust-side image extension list (clipboard/mod.rs
    // and pipeline.rs): both now treat .svg as an image, .avif stays a plain file.
    const fileImagePaths = useMemo(() => item.content_type === "file" ? filePaths.filter(p => /\.(png|jpe?g|jfif|gif|bmp|webp|svg)$/i.test(p)) : [], [item.content_type, filePaths]);
    const allFilesAreImages = filePaths.length > 1 && fileImagePaths.length === filePaths.length;
    const singleFilePath = filePaths.length === 1 ? filePaths[0] : null;
    const [fileIcon, setFileIcon] = useState<string | null>(() => peekFileIcon(singleFilePath) ?? null);
    const isComposing = useRef(false);
    const richSnapshotImgRef = useRef<HTMLImageElement | null>(null);
    const richSnapshotFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverAnchorRef = useRef<CompactPreviewAnchor | null>(null);

    const richTextFallback = item.content_type === "rich_text" && item.html_content ? (() => { const { cleanHtml, imagePayload } = extractRichImageFallback(item.html_content); return { cleanHtml: cleanHtml || item.html_content, imageSrc: resolveRichImageSrc(imagePayload) }; })() : null;
    const richTextCleanHtml = richTextFallback?.cleanHtml || item.html_content || "";
    const richTextSnapshotDisplayMaxHeight = compactMode ? 40 : 64;
    const richTextSnapshotRenderMaxHeight = compactMode ? 100 : 200;
    const canShowCompactPreview = compactMode
        && item.content_type !== "file"
        && !(item.is_external && item.file_preview_exists === false);
    
    const richTextSnapshotSrc = useMemo(() => {
        if (!richTextSnapshotPreview || item.content_type !== "rich_text" || !item.html_content || !richTextCleanHtml) return null;
        return getRichTextSnapshotDataUrl(richTextCleanHtml, { width: compactMode ? 360 : 560, maxHeight: richTextSnapshotRenderMaxHeight });
    }, [richTextSnapshotPreview, item.content_type, item.html_content, richTextCleanHtml, compactMode, richTextSnapshotRenderMaxHeight]);

    const snapshotPreviewEnabled = !!richTextSnapshotPreview;
    const effectiveRichTextSnapshotSrc = snapshotPreviewEnabled && !snapshotFailed ? richTextSnapshotSrc : null;
    const useRichImageFallback = snapshotPreviewEnabled && !richImageFallbackFailed && !!richTextFallback?.imageSrc;
    const richTextPreviewSrc = useRichImageFallback ? (richTextFallback?.imageSrc || null) : effectiveRichTextSnapshotSrc;
    const useSnapshotPreviewImage = snapshotPreviewEnabled && !useRichImageFallback && !!effectiveRichTextSnapshotSrc;

    useEffect(() => {
        let cancelled = false;
        const sourceAppPath = item.source_app_path?.trim();
        const cachedIcon = peekSourceAppIcon(sourceAppPath);
        if (cachedIcon !== undefined) { setSourceAppIcon(cachedIcon ?? null); return () => { cancelled = true; }; }
        setSourceAppIcon(null);
        if (!sourceAppPath) return () => { cancelled = true; };
        getSourceAppIcon(sourceAppPath).then((icon) => { if (!cancelled) setSourceAppIcon(icon); });
        return () => { cancelled = true; };
    }, [item.source_app_path]);

    useEffect(() => {
        let cancelled = false;
        const cachedIcon = peekFileIcon(singleFilePath);
        if (cachedIcon !== undefined) { setFileIcon(cachedIcon ?? null); return () => { cancelled = true; }; }
        setFileIcon(null);
        if (item.content_type !== "file" || item.file_preview_exists === false || !singleFilePath) return () => { cancelled = true; };
        getFileIconDataUrl(singleFilePath).then((icon) => { if (!cancelled) setFileIcon(icon); });
        return () => { cancelled = true; };
    }, [item.content_type, item.file_preview_exists, singleFilePath]);

    const showCompactPreview = async (anchor: CompactPreviewAnchor) => {
        if (item.is_external && item.file_preview_exists === false) return;
        try {
            await compactPreviewController.show(anchor, {
                contentType: item.content_type,
                content: item.content,
                preview: item.preview,
                htmlContent: item.html_content,
                sourceApp: item.source_app,
                timestamp: item.timestamp,
                language,
                theme: "fluent",
                colorMode: colorMode === "light" ? "light" : "dark",
                richTextSnapshotPreview,
                clipboardItemFontSize,
                clipboardTagFontSize
            });
        } catch (err) {
            console.error("Failed to show compact preview:", err);
        }
    };

    useEffect(() => { setLocalTagInput(tagInput); }, [tagInput]);
    useEffect(() => { setSnapshotFailed(false); setRichImageFallbackFailed(false); }, [item.id, item.html_content, richTextSnapshotPreview, compactMode]);
    useEffect(() => {
        if (richSnapshotFallbackTimerRef.current) clearTimeout(richSnapshotFallbackTimerRef.current);
        if (!useSnapshotPreviewImage) return;
        richSnapshotFallbackTimerRef.current = setTimeout(() => { const img = richSnapshotImgRef.current; if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) setSnapshotFailed(true); }, 700);
        return () => { if (richSnapshotFallbackTimerRef.current) clearTimeout(richSnapshotFallbackTimerRef.current); };
    }, [useSnapshotPreviewImage, effectiveRichTextSnapshotSrc, item.id]);

    useEffect(() => { if (isEditingTags && tagInputRef.current) tagInputRef.current.focus(); }, [isEditingTags]);
    useEffect(() => { if (!canShowCompactPreview) void compactPreviewController.hide(); }, [canShowCompactPreview]);
    useEffect(() => { return () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); hoverAnchorRef.current = null; void compactPreviewController.hide(); }; }, []);

    useEffect(() => {
        if (!item.is_external || item.file_preview_exists === false || !onExternalMissing) return;
        const el = itemRef.current;
        if (!el) return;

        const runCheck = () => {
            if (externalCheckCache.size > 2000) externalCheckCache.clear();
            const now = Date.now();
            const lastCheck = externalCheckCache.get(item.id) || 0;
            if (now - lastCheck < EXTERNAL_CHECK_TTL_MS) return;
            externalCheckCache.set(item.id, now);

            invoke<boolean>("check_external_file_exists", { content: item.content })
                .then((exists) => {
                    if (!exists) onExternalMissing(item.id);
                })
                .catch(() => {});
        };

        let observer: IntersectionObserver | null = null;
        if (typeof IntersectionObserver !== "undefined") {
            observer = new IntersectionObserver((entries) => {
                if (entries.some(entry => entry.isIntersecting)) runCheck();
            }, { rootMargin: "80px 0px" });
            observer.observe(el);
        }

        // IntersectionObserver 只在布局/滚动导致相交状态变化时回调。
        // 面板打开时条目如果本来就在可视区域内，不会有任何回调；
        // 因此挂载时/面板每次显示（windowShowTick 变化）时，只要条目当前
        // 位于可视区域内就立即检测一次。
        const rect = el.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const inView =
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > -80 &&
            rect.top < viewportHeight + 80;
        if (inView) runCheck();

        return () => observer?.disconnect();
    }, [item.id, item.content, item.is_external, item.file_preview_exists, onExternalMissing, windowShowTick]);

    const renderFilePreview = () => {
        if (item.file_preview_exists === false) return <div className="file-thumbnail-card error-bg" title={t('file_deleted')}><div className="file-icon-wrapper error-icon"><FileQuestion size={24} /></div><div className="file-info-wrapper"><div className="file-name error-text">{t('file_deleted')}</div><div className="file-hint error-text">{filePaths.length > 1 ? item.content : filePaths[0].split(/[\\/]/).pop()}</div></div></div>;
        if (filePaths.length > 1 && allFilesAreImages) {
            const shown = fileImagePaths.slice(0, 5);
            return (
                <div className="file-thumbnail-card" title={item.content} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                        {shown.map((p, i) => (
                            <img key={i} src={toTauriLocalImageSrc(p) || convertFileSrc(p)} alt="" loading="lazy"
                                style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--line-soft, rgba(128,128,128,0.25))', background: 'var(--bg-secondary, rgba(128,128,128,0.08))' }}
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                        ))}
                    </div>
                    <div className="file-info-wrapper" style={{ minWidth: 0 }}>
                        <div className="file-name">{filePaths.length} {t('items')}</div>
                        <div className="file-hint">{fileImagePaths[0].split(/[\\/]/).pop()}{fileImagePaths.length > shown.length ? ` +${fileImagePaths.length - shown.length}` : ''}</div>
                    </div>
                </div>
            );
        }
        if (filePaths.length > 1) return <div className="file-thumbnail-card" title={item.content}><div className="file-icon-wrapper"><Files size={24} /></div><div className="file-info-wrapper"><div className="file-name">{filePaths.length} {t('items')}</div><div className="file-hint">{filePaths[0].split(/[\\/]/).pop()} ...</div></div></div>;
        const filePath = filePaths[0];
        return <div className="file-thumbnail-card" title={item.content}><div className={`file-icon-wrapper ${fileIcon ? 'file-icon-wrapper-system' : ''}`}>{fileIcon ? <img src={fileIcon} alt="" className="file-icon-image" /> : getFallbackFileIcon(filePath)}</div><div className="file-info-wrapper"><div className="file-name">{filePath.split(/[\\/]/).pop()}</div><div className="file-hint">{filePath.split(/[\\/]/).slice(0, -1).join('\\')}</div></div></div>;
    };

    return (
        <motion.div ref={itemRef} id={id} layout={!disableLayout} initial={false} animate={{ marginBottom: 0 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.1 }}
            className={`history-item ${isSelected ? "selected" : ""} ${compactMode ? "compact" : ""} ${item.is_pinned ? "pinned" : ""} ${item.content_type === 'file' ? 'file-item' : ''}`}
            data-selected={isSelected}
            onMouseDown={(e) => {
                // 阻止默认行为以防止在置顶模式下点击时原窗口失去光标焦点
                if (!(e.target as HTMLElement).closest('button, input, textarea')) {
                    e.preventDefault();
                }
            }}
            onClick={(e) => { if ((e.target as HTMLElement).closest('button, input, textarea')) return; if (item.is_external && item.file_preview_exists === false) { onSelect(); onOpen(e); return; } void compactPreviewController.hide(); onCopy(false); onSelect(); }}
            onContextMenu={(e) => { if ((e.target as HTMLElement).closest('button, input, textarea')) return; if (item.is_external && item.file_preview_exists === false) { onSelect(); onOpen(e); return; } void compactPreviewController.hide(); e.preventDefault(); onCopy(true); onSelect(); }}
            onMouseEnter={(e) => {
                if (!canShowCompactPreview) return;
                const rect = itemRef.current?.getBoundingClientRect();
                hoverAnchorRef.current = {
                    clientX: e.clientX,
                    clientY: e.clientY,
                    screenX: e.screenX,
                    screenY: e.screenY,
                    itemRect: rect
                        ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
                        : { left: e.clientX, top: e.clientY, width: 0, height: 0 }
                };
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = setTimeout(() => { if (hoverAnchorRef.current) showCompactPreview(hoverAnchorRef.current); }, 200);
            }}
            onMouseMove={(e) => {
                if (!canShowCompactPreview) return;
                const prev = hoverAnchorRef.current;
                hoverAnchorRef.current = {
                    clientX: e.clientX,
                    clientY: e.clientY,
                    screenX: e.screenX,
                    screenY: e.screenY,
                    itemRect: prev?.itemRect || { left: e.clientX, top: e.clientY, width: 0, height: 0 }
                };
            }}
            onMouseLeave={() => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); hoverAnchorRef.current = null; void compactPreviewController.hide(); }}
        >
            <div className="item-header">
                <div className="item-app-info">
                    {dragControls && <div className="drag-handle" onPointerDown={(e) => dragControls.start(e)} style={{ cursor: 'grab', opacity: 0.5, marginRight: '4px' }}><GripVertical size={12} /></div>}
                    {item.is_pinned && !dragControls && <Pin size={10} style={{ color: 'var(--accent-color)', marginRight: '-2px', flexShrink: 0 }} />}
                    {showSourceAppIcon ? renderSourceAppIcon(sourceAppIcon, item.content_type, item.source_app) : getIcon(item.content_type)}
                    <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{item.source_app}</span>
                </div>
                <div className="item-timestamp" style={{ flexShrink: 0 }}>{getConciseTime(item.timestamp, language)}</div>
            </div>
            {compactMode && item.is_pinned && <div className="compact-pinned-indicator"><Pin size={10} fill="currentColor" /></div>}
            <div className={`content-preview ${item.content_type === 'rich_text' ? 'rich-text' : ''} ${item.content_type === 'file' ? 'file-preview' : ''} ${isSensitiveHidden ? 'sensitive-blur' : ''}`}>
                {item.content_type === "image" ? (
                    <div style={{ position: 'relative' }}>
                        {item.is_external && item.file_preview_exists === false ? <div className="image-preview error-placeholder" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', height: '100px', fontSize: '12px' }}><ImageOff size={24} style={{ marginBottom: '8px', opacity: 0.5 }} /><span style={{ marginBottom: '8px' }}>{t('image_deleted')}</span><span style={{ fontSize: '10px', opacity: 0.7, maxWidth: '80%', wordBreak: 'break-all', textAlign: 'center' }}>{item.content.split(/[\\/]/).pop()}</span></div> : <img src={item.content.startsWith("data:") ? item.content : (toTauriLocalImageSrc(item.content) || convertFileSrc(item.content))} alt={t('image_preview')} className="image-preview" style={isSensitiveHidden ? { filter: 'blur(8px)' } : {}} onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.parentElement?.classList.add('image-load-error'); }} />}
                        {isSensitiveHidden && <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontWeight: 'bold', opacity: 0.5, fontSize: '10px' }}>SENSITIVE</div>}
                    </div>
                ) : item.content_type === "video" ? (
                    <div className="video-thumbnail-card"><div className="video-thumbnail-wrapper"><video src={item.content.startsWith("data:") ? item.content : (toTauriLocalImageSrc(item.content) || item.content)} preload="metadata" muted playsInline className="video-thumbnail-element" onLoadedMetadata={(e) => seekVideoPreviewFrame(e.currentTarget)} /><div className="video-play-overlay"><Video size={16} /></div></div><div className="video-info-wrapper"><div className="video-name">{item.content.split(/[\\/]/).pop()}</div></div></div>
                ) : item.content_type === "file" ? (
                    renderFilePreview()
                ) : item.content_type === "rich_text" && item.html_content && !isSensitiveHidden ? (
                    richTextPreviewSrc ? <img ref={richSnapshotImgRef} src={richTextPreviewSrc} alt="rich text preview" onLoad={() => { if (useSnapshotPreviewImage && richSnapshotFallbackTimerRef.current) { clearTimeout(richSnapshotFallbackTimerRef.current); richSnapshotFallbackTimerRef.current = null; } }} onError={() => { if (useRichImageFallback) { setRichImageFallbackFailed(true); return; } if (richSnapshotFallbackTimerRef.current) { clearTimeout(richSnapshotFallbackTimerRef.current); richSnapshotFallbackTimerRef.current = null; } if (effectiveRichTextSnapshotSrc) setSnapshotFailed(true); }} style={{ width: 'auto', maxWidth: '100%', maxHeight: `${richTextSnapshotDisplayMaxHeight}px`, display: 'block', marginRight: 'auto', pointerEvents: 'none', borderRadius: '4px', maskImage: 'linear-gradient(to bottom, black 78%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 78%, transparent 100%)' }} /> : <HtmlContent className="rich-text-preview" htmlContent={richTextCleanHtml || item.html_content} fallbackText={item.preview} preview={true} style={{ maxHeight: `${richTextSnapshotDisplayMaxHeight}px`, overflow: 'hidden', fontSize: 'var(--clipboard-item-font-size)', lineHeight: '1.4', position: 'relative', pointerEvents: 'none', maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)' }} />
                ) : (
                    isSensitiveHidden ? <div style={{ minHeight: '24px', opacity: 0.6, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-mono)' }}><span style={{ letterSpacing: '1px' }}>{item.preview.substring(0, 3)}...</span><span style={{ fontSize: '10px', opacity: 0.7 }}>({item.content.length} {t('chars')})</span></div> : item.preview
                )}
            </div>
            <div className="item-footer">
                {(!autoHideTags || isEditingTags) && (
                    <div className="item-tags-container">
                        {item.tags?.map(tag => (
                            <span key={tag} className="tag-chip" style={{ background: getTagColor(tag, "fluent"), display: 'flex', alignItems: 'center', gap: '4px' }}>{tag}{isEditingTags && <button onClick={(e) => { e.stopPropagation(); onTagDelete(tag); }} style={{ background: 'none', border: 'none', padding: 0, color: 'currentColor', cursor: 'pointer', display: 'flex', opacity: 0.6 }}><X size={8} /></button>}</span>
                        ))}
                        {isEditingTags && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                <input 
                                    ref={tagInputRef} 
                                    type="text" 
                                    value={localTagInput} 
                                    onCompositionStart={() => { isComposing.current = true; }} 
                                    onCompositionEnd={(e) => { 
                                        isComposing.current = false; 
                                        const val = (e.target as HTMLInputElement).value; 
                                        setLocalTagInput(val); 
                                        onTagInput(val); 
                                    }} 
                                    onMouseDown={(e) => { 
                                        e.stopPropagation();
                                        invoke('activate_window_focus').catch(console.error); 
                                    }} 
                                    onFocus={() => { invoke('activate_window_focus').catch(console.error); }} 
                                    onChange={(e) => { 
                                        const val = e.target.value; 
                                        setLocalTagInput(val); 
                                        if (!isComposing.current) onTagInput(val); 
                                    }} 
                                    onKeyDown={(e) => { 
                                        // Stop propagation to avoid conflicts with global list navigation
                                        e.stopPropagation();
                                        console.log('Tag input keydown:', e.key, 'isComposing:', isComposing.current);

                                        if (e.key === 'Enter' && !isComposing.current) {
                                            e.preventDefault();
                                            // If input is empty, Enter can be used to close the editor
                                            if (localTagInput.trim() === '') {
                                                console.log('Enter on empty - closing editor');
                                                onToggleTagEditor(e as any);
                                            } else {
                                                console.log('Enter - adding tag:', localTagInput);
                                                onTagAdd();
                                            }
                                        } else if (e.key === 'Escape') {
                                            e.preventDefault();
                                            console.log('Escape - closing editor');
                                            onToggleTagEditor(e as any);
                                        }
                                        // Let Tab, Arrows etc. pass through to the element, but propagation is stopped
                                    }} 
                                    className="tag-input" 
                                    placeholder="..." 
                                    style={{ background: 'var(--bg-input)', border: '1px solid var(--line-soft)', borderRadius: '4px', padding: '2px 6px', fontSize: '10px', color: 'var(--text-primary)', width: '50px', outline: 'none' }} 
                                    onClick={e => e.stopPropagation()} 
                                />
                                <button 
                                    onClick={(e) => { 
                                        e.stopPropagation(); 
                                        onTagAdd(); 
                                    }} 
                                    className="btn-icon" 
                                    style={{ padding: '2px', height: '18px', width: '18px' }}
                                >
                                    <Plus size={10} />
                                </button>
                            </div>
                        )}
                    </div>
                )}
                {!isEditingTags && autoHideTags && <div className="item-tags-placeholder" />}
                <div className="item-actions">
                    {isSensitiveHidden && <button className={`btn-icon ${isRevealed ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); onToggleReveal(e); }} title={t('reveal')}><Eye size={12} /></button>}
                    {!isSensitiveHidden && (item.tags?.includes('sensitive') || item.tags?.includes('密码')) && <button className={`btn-icon active`} onClick={(e) => { e.stopPropagation(); onToggleReveal(e); }} title={t('hide')}><EyeOff size={12} /></button>}
                    {onStickyCreate && item.content_type !== "file" && item.content_type !== "video" && <button className="btn-icon" onClick={(e) => { e.stopPropagation(); onStickyCreate(e); }} title={t('pin_to_desktop')}><StickyNote size={12} /></button>}
                    <button className={`btn-icon ${item.is_external && item.file_preview_exists === false ? 'disabled' : ''}`} onClick={(e) => { e.stopPropagation(); if (item.is_external && item.file_preview_exists === false) { onOpen(e); return; } onOpen(e); }} title={t('open')}><ExternalLink size={12} /></button>
                    <button className={`btn-icon ${item.is_pinned ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); onTogglePin(e); }} title={item.is_pinned ? t('unpin') : t('pin')}>{item.is_pinned ? <PinOff size={12} /> : <Pin size={12} />}</button>
                    <button className={`btn-icon ${isEditingTags ? "active" : ""}`} onClick={(e) => { e.stopPropagation(); onToggleTagEditor(e); }} title="Tags"><Tag size={12} /></button>
                    <button className="btn-icon" onClick={(e) => { e.stopPropagation(); onDelete(e); }} title={t('delete')}><X size={12} /></button>
                </div>
            </div>
        </motion.div>
    );
};

export default memo(ClipboardItem, (prev, next) => {
    return prev.index === next.index && prev.item.id === next.item.id && prev.item.timestamp === next.item.timestamp && prev.item.content === next.item.content && prev.item.is_pinned === next.item.is_pinned && prev.item.tags === next.item.tags && prev.item.file_preview_exists === next.item.file_preview_exists;
});
