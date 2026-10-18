import { useEffect, type ReactNode } from 'react';

/** Centered dialog; closes on Escape or a click on the backdrop. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex justify-center bg-black/40 pt-[15vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="h-fit w-[440px] max-w-[90vw] rounded-xl bg-white p-5 text-[15px] text-gray-900 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button className="px-1 text-xl leading-none text-gray-400 hover:text-gray-900" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
