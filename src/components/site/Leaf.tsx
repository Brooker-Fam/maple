import { useId } from "react";

const LEAF =
  "M50 4 L55.5 15.5 L62.5 11.5 L60.5 28 Q61.5 36.5 69.5 32.5 L77 22.5 L81 28 L95 24.5 L88.5 37.5 L94 42 L80.5 50.5 Q75 58.5 67.5 55.5 L72 64 L60 61.5 L53.6 66 L51.7 67.5 L52.9 86 L47.1 86 L48.3 67.5 L46.4 66 L40 61.5 L28 64 L32.5 55.5 Q25 58.5 19.5 50.5 L6 42 L11.5 37.5 L5 24.5 L19 28 L23 22.5 L30.5 32.5 Q38.5 36.5 39.5 28 L37.5 11.5 L44.5 15.5 L50 4 Z";

export default function Leaf({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 100 92" width={size} height={size * 0.92} aria-hidden focusable="false" className={className}>
      <defs>
        <linearGradient id={id} x1="0.2" y1="0" x2="0.75" y2="1">
          <stop offset="0" stopColor="#E8902F" />
          <stop offset="0.55" stopColor="#CC4A2A" />
          <stop offset="1" stopColor="#A3321F" />
        </linearGradient>
      </defs>
      <path d={LEAF} fill={`url(#${id})`} />
      <path d="M50 64V13M50 58L86 28.5M50 58L14 28.5" stroke="#F8DB97" strokeOpacity="0.6" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}
