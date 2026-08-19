export type ToastItem = {
  id: number;
  msg: string;
};

export type ConfirmOption = {
  id: string;
  label: string;
};

export type ConfirmDialogState = {
  show: boolean;
  title: string;
  message: string;
  options?: ConfirmOption[];
  onConfirm: (selectedId?: string) => void;
  onCancel?: () => void;
};
