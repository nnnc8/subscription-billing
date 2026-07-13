import { useEffect, useRef } from 'react';
import type { MouseEvent, ReactNode, RefObject } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  size?: 'default' | 'wide';
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  labelledBy,
  initialFocusRef,
  size = 'default',
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        openerRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
        dialog.showModal();
      }
      initialFocusRef?.current?.focus();
      return;
    }

    if (dialog.open) dialog.close();
    if (openerRef.current?.isConnected) openerRef.current.focus();
    openerRef.current = null;
  }, [initialFocusRef, open]);

  useEffect(() => () => {
    if (dialogRef.current?.open) dialogRef.current.close();
    if (openerRef.current?.isConnected) openerRef.current.focus();
  }, []);

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className={`modal-dialog${size === 'wide' ? ' modal-dialog-wide' : ''}`}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={handleBackdropClick}
    >
      <div className="modal-content">{children}</div>
    </dialog>
  );
}
