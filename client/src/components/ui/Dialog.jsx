// Styled replacements for window.confirm / window.prompt — same
// overlay language as the edit modals (CatalogEditModals ModalShell),
// but z-50 so a dialog opened FROM a z-40 modal layers above it.
//
// Usage pattern (state-driven, render-when-open):
//
//   const [confirming, setConfirming] = useState(false);
//   ...
//   {confirming && (
//     <ConfirmDialog
//       title="Deactivate resource?"
//       message={`Deactivate "${resource.name}"? ...`}
//       confirmLabel="Deactivate"
//       onConfirm={() => { setConfirming(false); doIt(); }}
//       onClose={() => setConfirming(false)}
//     />
//   )}
//
// ConfirmDialog variants: 'danger' (default — destructive actions)
// and 'neutral' (safe/undoable actions, primary-styled confirm).
// InputDialog is the prompt() replacement (e.g. optional cancel
// reason); submitting with an empty value is allowed — dismissing is
// the only "no".

import { useEffect, useState } from 'react';
import Button from './Button.jsx';
import { Field, Input } from './Field.jsx';

function DialogShell({ title, onClose, children }) {
  // Escape closes, matching what users expect from native dialogs.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="absolute inset-0 bg-slate-900/30"
        onClick={onClose}
        aria-label="Close"
      />
      <div className="relative w-full max-w-sm rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger', // 'danger' | 'neutral'
  onConfirm,
  onClose,
}) {
  return (
    <DialogShell title={title} onClose={onClose}>
      {message && (
        <p className="mt-2 whitespace-pre-line text-sm text-slate-600">
          {message}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button
          autoFocus
          type="button"
          variant={variant === 'danger' ? 'danger' : 'primary'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </DialogShell>
  );
}

export function InputDialog({
  title,
  message,
  label,
  placeholder,
  initialValue = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'neutral', // 'danger' | 'neutral'
  onSubmit, // (value: string) => void — called with the (possibly empty) input
  onClose,
}) {
  const [value, setValue] = useState(initialValue);

  function submit(e) {
    e.preventDefault();
    onSubmit(value);
  }

  return (
    <DialogShell title={title} onClose={onClose}>
      {message && (
        <p className="mt-2 whitespace-pre-line text-sm text-slate-600">
          {message}
        </p>
      )}
      <form onSubmit={submit}>
        <Field label={label} className="mt-4">
          <Input
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button
            type="submit"
            variant={variant === 'danger' ? 'danger' : 'primary'}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
