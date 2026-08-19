import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check } from 'lucide-react';
import type { ConfirmOption } from '../types';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  options?: ConfirmOption[];
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: (selectedId?: string) => void;
  onClose: () => void;
}

const ConfirmDialog = ({
  open,
  title,
  message,
  options,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose
}: ConfirmDialogProps) => {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  // 打开时重置选中项：默认选中第一项
  useEffect(() => {
    if (open) {
      setSelectedId(options && options.length > 0 ? options[0].id : undefined);
    }
  }, [open, options]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="modal-overlay"
          onClick={onClose}
          style={{ zIndex: 1000000 }}
          initial={{ opacity: 0, backdropFilter: 'blur(0px)' }}
          animate={{ opacity: 1, backdropFilter: 'blur(8px)' }}
          exit={{ opacity: 0, backdropFilter: 'blur(0px)' }}
          transition={{ duration: 0.2 }}
        >
          <motion.div
            className="confirm-dialog theme-fluent"
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', damping: 30, stiffness: 400 }}
          >
            <div className="confirm-dialog-title">{title}</div>
            {message && <div className="confirm-dialog-message">{message}</div>}
            {options && options.length > 0 && (
              <div className="confirm-dialog-options" role="listbox">
                {options.map((opt) => {
                  const isSelected = selectedId === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={`confirm-option ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedId(opt.id)}
                    >
                      <span className="confirm-option-label">{opt.label}</span>
                      {isSelected && <Check size={16} className="confirm-option-check" />}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="confirm-dialog-buttons">
              <button className="confirm-dialog-button" onClick={onClose}>
                {cancelLabel}
              </button>
              <button className="confirm-dialog-button primary" onClick={() => onConfirm(selectedId)}>
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default ConfirmDialog;
