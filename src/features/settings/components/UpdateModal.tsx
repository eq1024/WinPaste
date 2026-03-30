import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";
import type { UpdateModalData } from "../types";

interface UpdateModalProps {
    data: UpdateModalData | null;
    t: (key: string) => string;
    onClose: () => void;
    setUpdateStatus: (val: string) => void;
}

const UpdateModal = ({ data, t, onClose, setUpdateStatus }: UpdateModalProps) => (
    <AnimatePresence>
        {data && (
            <div className="modal-overlay" onClick={onClose}>
                <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.9, opacity: 0 }}
                    className="modal-content"
                    style={{
                        width: '90%',
                        maxWidth: '320px',
                        gap: '16px',
                        display: 'flex',
                        flexDirection: 'column',
                        maxHeight: '90vh',
                        overflowY: 'auto'
                    }}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span role="img" aria-label="rocket">🚀</span>
                            {t('new_version_found')}
                            <span style={{ fontSize: '12px', background: 'var(--accent-color)', color: '#fff', padding: '2px 6px', borderRadius: '4px' }}>v{data.version}</span>
                        </h3>
                        <button className="btn-icon" onClick={onClose} style={{ border: 'none', background: 'transparent', boxShadow: 'none', padding: '4px' }}>
                            <X size={18} />
                        </button>
                    </div>

                    <div style={{
                        padding: '12px',
                        background: 'rgba(0,0,0,0.03)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        whiteSpace: 'pre-wrap',
                        fontSize: '13px',
                        lineHeight: '1.6',
                        color: 'var(--text-primary)',
                        maxHeight: '200px',
                        overflowY: 'auto'
                    }}>
                        {data.notes || t('no_release_notes')}
                    </div>

                    <div style={{ display: 'flex', gap: '12px' }}>
                        <button
                            className="btn-icon"
                            onClick={onClose}
                            style={{ flex: 1, height: '38px', fontWeight: 'bold' }}
                        >
                            {t('cancel')}
                        </button>
                        <button
                            className="btn-icon active"
                            onClick={async () => {
                                const url = data.downloadUrl;
                                onClose();

                                // Start Download
                                setUpdateStatus(t('downloading'));
                                try {
                                    await invoke("download_and_install_update", { url });
                                    setUpdateStatus('');
                                } catch (e: unknown) {
                                    console.error(e);
                                    setUpdateStatus(t('download_failed'));
                                    const errorMsg = e instanceof Error ? e.message : String(e);
                                    await message(
                                        t('download_failed_with_error').replace('{e}', errorMsg),
                                        { title: t('error'), kind: 'error' }
                                    );
                                }
                            }}
                            style={{ flex: 1.5, height: '38px', fontWeight: 'bold' }}
                        >
                            {t('update_now')}
                        </button>
                    </div>
                </motion.div>
            </div>
        )}
    </AnimatePresence>
);

export default UpdateModal;
