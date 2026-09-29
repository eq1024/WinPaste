import { invoke } from "@tauri-apps/api/core";
import Select from "react-select";
import type { SingleValue } from "react-select";
import { settingsSelectStyles } from "./settingsSelectStyles";
import type { SettingsSelectOption } from "./settingsSelectStyles";

interface SettingsSelectProps {
    value: string;
    options: SettingsSelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    isDisabled?: boolean;
    isClearable?: boolean;
    /** 面板是"无焦点"窗口,展开下拉前需要把焦点抢回来,否则菜单点不动。 */
    focusPanelOnOpen?: boolean;
}

/**
 * 设置面板里的下拉选择器。
 *
 * 统一使用 react-select(与"默认打开程序"选择器同款样式),
 * 避免原生 <select> 的弹出层无法跟随主题的问题。
 */
const SettingsSelect = ({
    value,
    options,
    onChange,
    placeholder,
    className,
    isDisabled = false,
    isClearable = false,
    focusPanelOnOpen = true
}: SettingsSelectProps) => (
    <Select<SettingsSelectOption, false>
        className={className ?? "settings-select"}
        classNamePrefix="settings-select"
        options={options}
        value={options.find((option) => option.value === value) ?? null}
        isSearchable={false}
        isClearable={isClearable}
        isDisabled={isDisabled}
        placeholder={placeholder}
        menuPortalTarget={document.body}
        menuPosition="fixed"
        onFocus={focusPanelOnOpen ? () => invoke("focus_clipboard_window").catch(console.error) : undefined}
        onChange={(option: SingleValue<SettingsSelectOption>) => {
            if (option) onChange(option.value);
        }}
        styles={settingsSelectStyles}
    />
);

export default SettingsSelect;
