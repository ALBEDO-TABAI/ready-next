import readyWordmark from '../../assets/ready-wordmark.png'

export default function ModeSlider() {
  return (
    <div
      className="flex h-[28px] w-[96px] items-center"
      style={{
        paddingLeft: 25,
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
        }}
      />
    </div>
  )
}
