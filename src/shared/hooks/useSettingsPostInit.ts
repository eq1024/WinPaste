import { useEffect } from "react";
import { useSettingsStore } from "../store/settingsStore";
import { useUIStore } from "../store/uiStore";

interface UseSettingsPostInitOptions {
  settings: Record<string, string> | null;
}

export const useSettingsPostInit = ({
  settings
}: UseSettingsPostInitOptions) => {
  const {
    setClipboardItemFontSize,
    setClipboardTagFontSize,
    setVibrancyEnabled,
    setPersistent,
    setPersistentLimitEnabled,
    setPersistentLimit,
    setDeduplicate,
    setCaptureFiles,
    setCaptureRichText,
    setRichTextSnapshotPreview,
    setPrivacyProtection,
    setPrivacyProtectionKinds,
    setPrivacyProtectionCustomRules,
    setSilentStart,
    setFollowMouse,
    setShowAppBorder,
    setShowSourceAppIcon,
    setDeleteAfterPaste,
    setMoveToTopAfterPaste,
    setHideTrayIcon,
    setEdgeDocking,
    setArrowKeySelection,
    setRegistryWinVEnabled,
    setHotkey,
    setSequentialHotkey,
    setRichPasteHotkey,
    setSearchHotkey,
    setSequentialModeState,
    setSoundEnabled,
    setSoundVolume,
    setPasteSoundEnabled,
    setPasteMethod,
    setSettingsLoaded,
  } = useSettingsStore();

  const {
    setTagManagerEnabled,
    setIsWindowPinned,
    setShowSearchBox,
    setScrollTopButtonEnabled,
  } = useUIStore();

  useEffect(() => {
    if (!settings) return;

    if (settings["app.clipboard_item_font_size"]) {
      const fs = parseInt(settings["app.clipboard_item_font_size"]);
      if (!isNaN(fs)) setClipboardItemFontSize(fs);
    }
    if (settings["app.clipboard_tag_font_size"]) {
      const fs = parseInt(settings["app.clipboard_tag_font_size"]);
      if (!isNaN(fs)) setClipboardTagFontSize(fs);
    }

    if (settings["app.tag_manager_enabled"] !== undefined) setTagManagerEnabled(settings["app.tag_manager_enabled"] === 'true');

    if (settings["app.persistent"] !== undefined) setPersistent(settings["app.persistent"] === 'true');
    if (settings["app.persistent_limit_enabled"] !== undefined) setPersistentLimitEnabled(settings["app.persistent_limit_enabled"] === 'true');
    if (settings["app.persistent_limit"] !== undefined) {
      const pl = parseInt(settings["app.persistent_limit"]);
      if (!isNaN(pl)) setPersistentLimit(pl);
    }

    if (settings["app.deduplicate"] !== undefined) setDeduplicate(settings["app.deduplicate"] === 'true');
    if (settings["app.capture_files"] !== undefined) setCaptureFiles(settings["app.capture_files"] === 'true');
    if (settings["app.capture_rich_text"] !== undefined) setCaptureRichText(settings["app.capture_rich_text"] === 'true');
    if (settings["app.rich_text_snapshot_preview"] !== undefined) setRichTextSnapshotPreview(settings["app.rich_text_snapshot_preview"] === 'true');
    if (settings["app.privacy_protection"] !== undefined) setPrivacyProtection(settings["app.privacy_protection"] === 'true');
    if (settings["app.privacy_protection_kinds"] !== undefined) {
      setPrivacyProtectionKinds(settings["app.privacy_protection_kinds"].split(',').map(s => s.trim()).filter(Boolean));
    }
    if (settings["app.privacy_protection_custom_rules"] !== undefined) {
      setPrivacyProtectionCustomRules(settings["app.privacy_protection_custom_rules"]);
    }
    if (settings["app.silent_start"] !== undefined) setSilentStart(settings["app.silent_start"] === 'true');
    if (settings["app.follow_mouse"] !== undefined) setFollowMouse(settings["app.follow_mouse"] === 'true');
    if (settings["app.show_app_border"] !== undefined) setShowAppBorder(settings["app.show_app_border"] === 'true');
    if (settings["app.show_source_app_icon"] !== undefined) setShowSourceAppIcon(settings["app.show_source_app_icon"] === 'true');
    if (settings["app.vibrancy_enabled"] !== undefined) setVibrancyEnabled(settings["app.vibrancy_enabled"] !== 'false');
    if (settings["app.delete_after_paste"] !== undefined) setDeleteAfterPaste(settings["app.delete_after_paste"] === 'true');
    if (settings["app.move_to_top_after_paste"] !== undefined) setMoveToTopAfterPaste(settings["app.move_to_top_after_paste"] !== 'false');
    if (settings["app.hide_tray_icon"] !== undefined) setHideTrayIcon(settings["app.hide_tray_icon"] === 'true');
    if (settings["app.edge_docking"] !== undefined) setEdgeDocking(settings["app.edge_docking"] === 'true');
    if (settings["app.show_search_box"] !== undefined) setShowSearchBox(settings["app.show_search_box"] === 'true');
    if (settings["app.scroll_top_button_enabled"] !== undefined) setScrollTopButtonEnabled(settings["app.scroll_top_button_enabled"] !== 'false');
    if (settings["app.arrow_key_selection"] !== undefined) setArrowKeySelection(settings["app.arrow_key_selection"] === 'true');

    if (settings["app.use_win_v_shortcut"] !== undefined) setRegistryWinVEnabled(settings["app.use_win_v_shortcut"] === 'true');

    if (settings["app.hotkey"]) setHotkey(settings["app.hotkey"]);
    if (settings["app.sequential_hotkey"]) setSequentialHotkey(settings["app.sequential_hotkey"]);
    if (settings["app.rich_paste_hotkey"]) setRichPasteHotkey(settings["app.rich_paste_hotkey"]);
    if (settings["app.search_hotkey"]) setSearchHotkey(settings["app.search_hotkey"]);
    if (settings["app.sequential_mode"] !== undefined) setSequentialModeState(settings["app.sequential_mode"] === 'true');

    if (settings["app.sound_enabled"] !== undefined) setSoundEnabled(settings["app.sound_enabled"] === 'true');
    if (settings["app.sound_volume"] !== undefined) {
      const vol = parseInt(settings["app.sound_volume"]);
      if (!isNaN(vol)) setSoundVolume(vol);
    }
    if (settings["app.paste_sound_enabled"] !== undefined) setPasteSoundEnabled(settings["app.paste_sound_enabled"] === 'true');

    if (settings["app.paste_method"]) setPasteMethod(settings["app.paste_method"]);

    if (settings["app.window_pinned"] !== undefined) {
      setIsWindowPinned(settings["app.window_pinned"] === 'true');
    }

    setSettingsLoaded(true);

  }, [settings]);
};
