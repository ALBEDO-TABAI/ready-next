export default function ModeSlider() {
  return (
    <div
      className="flex h-[28px] w-[96px] items-center justify-end"
      style={{
        marginRight: -1,
      }}
    >
      <div
        role="img"
        aria-label="Ready"
        style={{
          display: 'block',
          width: 14,
          height: 14,
          borderRadius: 999,
          background: 'var(--rn-accent)',
          boxShadow: '0 0 0 0.5px color-mix(in srgb, var(--rn-accent) 58%, color-mix(in srgb, var(--rn-sheet) 52%, transparent))',
        }}
      />
    </div>
  )
}
