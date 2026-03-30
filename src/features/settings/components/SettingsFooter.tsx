import { Github, RotateCcw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpdateModalData } from "../types";

interface SettingsFooterProps {
    t: (key: string) => string;
    appVersion: string;
    updateStatus: string;
    setUpdateStatus: (val: string) => void;
    setUpdateModalData: (val: UpdateModalData | null) => void;
    onResetSettings: () => void;
    emailCopied: boolean;
    setEmailCopied: (val: boolean) => void;
}

const SettingsFooter = ({
    t,
    appVersion,
    updateStatus,
    setUpdateStatus,
    setUpdateModalData,
    onResetSettings,
}: SettingsFooterProps) => (
    <>
        {/* Footer Actions */}
        <div style={{
            marginTop: '16px',
            display: 'flex',
            justifyContent: 'center',
            gap: '12px',
            flexWrap: 'wrap'
        }}>
            {/* Reset Card */}
            <div
                className="settings-group"
                style={{
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    margin: 0,
                    width: 'auto',
                    padding: '10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '0'
                }}
                onClick={() => onResetSettings()}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <RotateCcw size={16} />
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{t('reset_defaults')}</span>
                </div>
            </div>
        </div>

        {/* Version Info */}
        <div style={{
            marginTop: '16px',
            marginBottom: '32px',
            textAlign: 'center',
            opacity: 1
        }}>
            <div style={{
                fontSize: '13px',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                letterSpacing: '0.5px',
                marginBottom: '4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
            }}>
                <span>winpaste {appVersion ? `v${appVersion}` : ""}</span>
                <button
                    onClick={async () => {
                        if (updateStatus) return;
                        setUpdateStatus(t('checking'));
                        try {
                            // Fetch latest release info directly from GitHub API
                            const response = await fetch('https://api.github.com/repos/eq1024/WinPaste/releases/latest');
                            if (!response.ok) throw new Error('GitHub API unreachable');

                            const data = await response.json();
                            // GitHub uses tag_name like "v0.3.2"
                            const remoteVersion = data.tag_name.replace(/^v/, '');
                            const currentVersion = appVersion || '0.0.0';

                            const v1 = remoteVersion.split('.').map(Number);
                            const v2 = currentVersion.split('.').map(Number);
                            let isNewer = false;
                            for (let i = 0; i < Math.max(v1.length, v2.length); i++) {
                                const num1 = v1[i] || 0;
                                const num2 = v2[i] || 0;
                                if (num1 > num2) { isNewer = true; break; }
                                if (num1 < num2) { break; }
                            }

                            if (isNewer) {
                                setUpdateStatus('');
                                // Use release body as release notes
                                const notes = data.body || t('no_release_notes');
                                // Find the first .exe asset for Windows installer
                                const exeAsset = data.assets?.find((a: any) => a.name.toLowerCase().endsWith('.exe'));
                                const downloadUrl = exeAsset ? exeAsset.browser_download_url : data.html_url;

                                setUpdateModalData({
                                    version: remoteVersion,
                                    notes: notes,
                                    downloadUrl: downloadUrl
                                });
                            } else {
                                setUpdateStatus(t('up_to_date'));
                                setTimeout(() => setUpdateStatus(''), 3000);
                            }
                        } catch (err) {
                            console.error('Update check failed:', err);
                            setUpdateStatus(t('checking_failed'));
                            setTimeout(() => setUpdateStatus(''), 3000);
                        }
                    }}
                    disabled={!!updateStatus}
                    style={{
                        border: 'none',
                        background: 'transparent',
                        color: (updateStatus && (updateStatus.includes('Failed') || updateStatus.includes('失败'))) ? '#ff4d4f' : 'var(--accent-color)',
                        cursor: updateStatus ? 'default' : 'pointer',
                        fontSize: '11px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        opacity: updateStatus ? 1 : 0.8,
                        fontWeight: updateStatus ? 'bold' : 'normal',
                        transition: 'all 0.2s'
                    }}
                    onMouseEnter={(e) => !updateStatus && (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={(e) => !updateStatus && (e.currentTarget.style.opacity = '0.8')}
                >
                    {updateStatus || t('check_update')}
                </button>
            </div>
            <div style={{
                fontSize: '11px',
                color: 'var(--text-secondary)',
                fontWeight: 500,
                marginBottom: '4px'
            }}>
                {t('slogan')}
            </div>
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
                flexWrap: 'wrap'
            }}>
                <button
                    onClick={() => openUrl('https://github.com/eq1024/WinPaste')}
                    style={{
                        fontSize: '11px',
                        color: 'var(--accent-color)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textDecoration: 'underline',
                        opacity: 0.7,
                        fontWeight: 600,
                        padding: '2px 4px',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px'
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                    onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
                >
                    <Github size={12} />
                    <span>GitHub</span>
                </button>
            </div>
        </div>
    </>
);

export default SettingsFooter;
