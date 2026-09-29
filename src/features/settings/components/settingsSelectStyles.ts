import type { GroupBase, StylesConfig } from "react-select";

export type SettingsSelectOption = { label: string; value: string };

/**
 * 设置面板里所有 react-select 下拉框共用的样式。
 *
 * 过去"粘贴方案"用的是原生 <select>:弹出层由浏览器/系统绘制,
 * 无法跟随主题(白底、灰选中、直角),在深色面板里非常突兀。
 * 现在统一走 react-select,外观与"默认打开程序"选择器保持一致。
 */
export const settingsSelectStyles: StylesConfig<SettingsSelectOption, false, GroupBase<SettingsSelectOption>> = {
    control: (base, state) => ({
        ...base,
        background: 'var(--bg-input)',
        border: state.isFocused ? '1px solid var(--input-focus-border-color)' : 'var(--input-border)',
        borderRadius: 'var(--input-radius)',
        boxShadow: state.isFocused ? 'var(--input-focus-shadow)' : 'none',
        minHeight: '32px',
        '&:hover': {
            border: state.isFocused ? '1px solid var(--input-focus-border-color)' : '1px solid var(--border-dark)',
        }
    }),
    menuPortal: (base) => ({
        ...base,
        zIndex: 99999,
    }),
    menu: (base) => ({
        ...base,
        background: 'var(--bg-panel)',
        borderRadius: 'var(--panel-radius)',
        border: 'var(--panel-border)',
        backdropFilter: 'blur(12px)',
        marginTop: '4px',
        zIndex: 99999,
        boxShadow: 'var(--panel-shadow)',
        maxHeight: '300px',
    }),
    menuList: (base) => ({
        ...base,
        maxHeight: '280px',
        overflowY: 'auto',
    }),
    option: (base, state) => ({
        ...base,
        background: state.isFocused ? 'var(--accent-color)' : 'transparent',
        color: state.isFocused ? 'var(--button-active-filled-color, #fff)' : 'var(--text-primary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: '12px'
    }),
    groupHeading: (base) => ({
        ...base,
        color: 'var(--text-secondary)',
        fontWeight: 'bold',
        fontSize: '11px',
        textTransform: 'uppercase',
        borderBottom: '1px solid var(--panel-divider-color)',
        marginBottom: '4px'
    }),
    placeholder: (base) => ({ ...base, fontSize: '12px', color: 'var(--text-muted)' }),
    input: (base) => ({ ...base, color: 'var(--text-primary)', fontSize: '12px' }),
    singleValue: (base) => ({ ...base, color: 'var(--text-primary)', fontSize: '12px' }),
    indicatorSeparator: (base) => ({ ...base, background: 'var(--border-light)' }),
    dropdownIndicator: (base) => ({ ...base, color: 'var(--text-secondary)', padding: '4px 6px' }),
    clearIndicator: (base) => ({ ...base, color: 'var(--text-secondary)', padding: '4px' }),
};

export default settingsSelectStyles;
