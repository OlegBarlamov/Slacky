import { useLayoutEffect, type RefObject } from 'react';

/** Same limit the server enforces (server/src/services/message.service.ts). */
export const MAX_MESSAGE_LENGTH = 4000;
const WARN_AT = MAX_MESSAGE_LENGTH - 500;

/** Grows a textarea with its content up to `maxVh` of the window, then it scrolls inside. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxVh = 40) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = (window.innerHeight * maxVh) / 100;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [ref, value, maxVh]);
}

export const isTooLong = (text: string) => text.trim().length > MAX_MESSAGE_LENGTH;

/** Shows how much room is left once a message gets close to the limit. */
export function LengthHint({ text }: { text: string }) {
  const length = text.trim().length;
  if (length < WARN_AT) return null;
  const left = MAX_MESSAGE_LENGTH - length;
  return (
    <span className={left < 0 ? 'font-semibold text-rose-600' : 'text-gray-500'}>
      {left < 0 ? `${-left} characters over the limit` : `${left} characters left`}
    </span>
  );
}
