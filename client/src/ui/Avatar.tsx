import type { User } from '@shared/types';

const COLORS = ['bg-rose-500', 'bg-amber-500', 'bg-emerald-600', 'bg-sky-600', 'bg-violet-600', 'bg-pink-600', 'bg-teal-600', 'bg-orange-600'];

function color(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

export function Avatar({ user, size = 36 }: { user: User | undefined; size?: number }) {
  return (
    <div
      className={`${color(user?.id ?? '?')} shrink-0 rounded-md text-white font-semibold grid place-items-center select-none`}
      style={{ width: size, height: size, fontSize: size * 0.45 }}
    >
      {(user?.name ?? '?')[0].toUpperCase()}
    </div>
  );
}
