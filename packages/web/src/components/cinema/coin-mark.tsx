export function CoinMark({ size = 18, className }: { readonly size?: number; readonly className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="var(--copper)" />
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="var(--ink)" strokeOpacity="0.35" strokeWidth="1.5" />
    </svg>
  );
}
