import type { ComponentType, ReactNode, CSSProperties } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Locale } from "../../../../shared/types";

interface LabelWithHintProps {
    label: string;
    hint?: string | ReactNode;
    hintKey: string;
}

interface AppearanceSettingsGroupProps {
    t: (key: string) => string;
    collapsed: boolean;
    onToggle: () => void;
    LabelWithHint: ComponentType<LabelWithHintProps>;
    language: Locale;
    setLanguage: (val: Locale) => void;
    showAppBorder: boolean;
    setShowAppBorder: (val: boolean) => void;
    colorMode: 'dark' | 'light' | 'system';
    setColorMode: (val: 'dark' | 'light' | 'system') => void;
    showSourceAppIcon: boolean;
    setShowSourceAppIcon: (val: boolean) => void;
    vibrancyEnabled: boolean;
    setVibrancyEnabled: (val: boolean) => void;
    compactMode: boolean;
    setCompactMode: (val: boolean) => void;
    clipboardItemFontSize: number;
    setClipboardItemFontSize: (val: number) => void;
    clipboardTagFontSize: number;
    setClipboardTagFontSize: (val: number) => void;
    saveAppSetting: (key: string, val: string) => void;
}

const clampProgress = (value: number, min: number, max: number) => {
    if (max <= min) return "0%";
    const pct = ((value - min) / (max - min)) * 100;
    return `${Math.min(100, Math.max(0, pct))}%`;
};

const buildRangeStyle = (value: number, min: number, max: number) =>
    ({
        width: '100%',
        cursor: 'pointer',
        accentColor: 'var(--accent-color)',
        "--range-progress": clampProgress(value, min, max)
    }) as CSSProperties;

const AppearanceSettingsGroup = ({
    t,
    collapsed,
    onToggle,
    LabelWithHint,
    language,
    setLanguage,
    showAppBorder,
    setShowAppBorder,
    colorMode,
    setColorMode,
    showSourceAppIcon,
    setShowSourceAppIcon,
    vibrancyEnabled,
    setVibrancyEnabled,
    compactMode,
    setCompactMode,
    clipboardItemFontSize,
    setClipboardItemFontSize,
    clipboardTagFontSize,
    setClipboardTagFontSize,
    saveAppSetting
}: AppearanceSettingsGroupProps) => {
    return (
    <div className={`settings-group ${collapsed ? 'collapsed' : ''}`}>
        <div className="group-header" onClick={onToggle}>
            <h3 style={{ margin: 0 }}>{t('appearance_settings')}</h3>
            {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </div>
        {!collapsed && (
            <div className="group-content">
                <div className="setting-item column no-border">
                    <div className="item-label-group" style={{ marginBottom: '8px' }}>
                        <span className="item-label">{t('color_mode')}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                        {[
                            { id: 'light', name: t('light_mode') },
                            { id: 'dark', name: t('dark_mode') },
                            { id: 'system', name: t('system_mode') }
                        ].map(mode => (
                            <button
                                key={mode.id}
                                onClick={() => {
                                    setColorMode(mode.id as 'dark' | 'light' | 'system');
                                    saveAppSetting('color_mode', mode.id);
                                }}
                                className={`btn-icon ${colorMode === mode.id ? 'active' : ''}`}
                                style={{ flex: 1, height: '36px', fontSize: '12px', fontWeight: 'bold' }}
                            >
                                {mode.name}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="setting-item column no-border">
                    <div className="item-label-group" style={{ marginBottom: '8px' }}>
                        <span className="item-label">{t('language')}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                        {[
                            { id: 'zh', name: '简体' },
                            { id: 'tw', name: '繁體' },
                            { id: 'en', name: 'English' }
                        ].map(lang => (
                            <button
                                key={lang.id}
                                onClick={() => {
                                    setLanguage(lang.id as Locale);
                                    saveAppSetting('language', lang.id);
                                }}
                                className={`btn-icon ${language === lang.id ? 'active' : ''}`}
                                style={{ flex: 1, height: '36px', fontSize: '12px', fontWeight: 'bold' }}
                            >
                                {lang.name}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="setting-item">
                    <LabelWithHint
                        label={t('vibrancy_enabled') || '系统毛玻璃特效'}
                        hint={t('vibrancy_enabled_hint') || '开启后应用 Mica (Win11) 或 Legacy Blur (Win10) 材质。关闭后恢复纯色背景。'}
                        hintKey="vibrancy_enabled"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={vibrancyEnabled}
                            onChange={(e) => {
                                const val = e.target.checked;
                                setVibrancyEnabled(val);
                                saveAppSetting('vibrancy_enabled', String(val));
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>

                <div className="setting-item">
                    <LabelWithHint
                        label={t('show_app_border') || '显示应用边框'}
                        hint={t('show_app_border_hint') || '关闭后隐藏主窗口边框和阴影'}
                        hintKey="show_app_border"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={showAppBorder}
                            onChange={(e) => {
                                const val = e.target.checked;
                                setShowAppBorder(val);
                                saveAppSetting('show_app_border', String(val));
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>

                <div className="setting-item">
                    <LabelWithHint
                        label={t('show_source_app_icon') || '显示来源应用图标'}
                        hint={t('show_source_app_icon_hint') || '关闭后不显示来源应用图标，改为显示剪贴板条目类型图标'}
                        hintKey="show_source_app_icon"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={showSourceAppIcon}
                            onChange={(e) => {
                                const val = e.target.checked;
                                setShowSourceAppIcon(val);
                                saveAppSetting('show_source_app_icon', String(val));
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>

                <div className="setting-item">
                    <LabelWithHint
                        label={t('compact_mode') || 'Compact Mode'}
                        hint={t('compact_mode_hint') || 'When enabled, clipboard list displays more densely with more entries visible. Hover to preview.'}
                        hintKey="compact_mode"
                    />
                    <label className="switch">
                        <input
                            className="cb"
                            type="checkbox"
                            checked={compactMode}
                            onChange={(e) => {
                                const val = e.target.checked;
                                setCompactMode(val);
                                saveAppSetting('compact_mode', String(val));
                            }}
                        />
                        <div className="toggle"><div className="left" /><div className="right" /></div>
                    </label>
                </div>

                <div className="setting-item column">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                        <LabelWithHint
                            label={t('clipboard_item_font_size') || '条目字体大小'}
                            hint={t('clipboard_item_font_size_hint') || '调整剪贴板首页条目内容的字体大小'}
                            hintKey="clipboard_item_font_size"
                        />
                        <span className="hint" style={{ fontSize: '10px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                            {clipboardItemFontSize}px
                        </span>
                    </div>
                    <input
                        type="range"
                        min="11"
                        max="18"
                        step="1"
                        value={clipboardItemFontSize}
                        onChange={(e) => {
                            const val = parseInt(e.target.value);
                            setClipboardItemFontSize(val);
                            saveAppSetting('clipboard_item_font_size', String(val));
                        }}
                        style={buildRangeStyle(clipboardItemFontSize, 11, 18)}
                    />
                </div>

                <div className="setting-item column">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                        <LabelWithHint
                            label={t('clipboard_tag_font_size') || '标签字体大小'}
                            hint={t('clipboard_tag_font_size_hint') || '调整剪贴板条目标签的字体大小'}
                            hintKey="clipboard_tag_font_size"
                        />
                        <span className="hint" style={{ fontSize: '10px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                            {clipboardTagFontSize}px
                        </span>
                    </div>
                    <input
                        type="range"
                        min="8"
                        max="14"
                        step="1"
                        value={clipboardTagFontSize}
                        onChange={(e) => {
                            const val = parseInt(e.target.value);
                            setClipboardTagFontSize(val);
                            saveAppSetting('clipboard_tag_font_size', String(val));
                        }}
                        style={buildRangeStyle(clipboardTagFontSize, 8, 14)}
                    />
                </div>
            </div>
        )}
    </div>
    );
};

export default AppearanceSettingsGroup;
