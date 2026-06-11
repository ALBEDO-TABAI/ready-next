import readyWordmark from '../../assets/ready-wordmark.png'

export default function ModeSlider() {
  return (
    <div
      className="flex h-[28px] w-[96px] items-center justify-end"
      style={{
        marginRight: -1,
      }}
    >
      <img
        src={readyWordmark}
        alt="Ready"
        draggable={false}
        style={{
          display: 'block',
          width: 69,
          height: 'auto',
          transform: 'scale(1.0725)',
          transformOrigin: 'right top',
        }}
      />
    </div>
  )
}
