const canvas = document.querySelector('#board')
const ctx = canvas.getContext('2d')
const occupied = new Set(['A1', 'B2', 'C2', 'D4', 'H3', 'H5'])
let col = 0
let row = 0
let message = ''
const seatAt = (x, y) => `${String.fromCharCode(65 + x)}${y + 1}`
function draw() {
  ctx.clearRect(0, 0, 640, 400)
  ctx.font = '18px sans-serif'
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 8; x++) {
      const seat = seatAt(x, y)
      ctx.fillStyle = occupied.has(seat) ? '#aab0b6' : '#c8eadc'
      ctx.fillRect(24 + x * 76, 24 + y * 64, 60, 44)
      ctx.fillStyle = '#162c36'
      ctx.fillText(seat, 38 + x * 76, 53 + y * 64)
      if (x === col && y === row) {
        ctx.strokeStyle = '#1649c7'
        ctx.lineWidth = 3
        ctx.strokeRect(22 + x * 76, 22 + y * 64, 64, 48)
      }
    }
  ctx.fillStyle = '#a51818'
  ctx.fillText(message, 24, 375)
}
async function confirmSeat() {
  const seat = seatAt(col, row)
  if (occupied.has(seat)) {
    message = '该座位已有人'
    draw()
    return
  }
  const response = await fetch('/canvas/api/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seat }),
  })
  if (response.ok) document.querySelector('#seat-status').textContent = `已确认座位 ${seat}`
}
canvas.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Enter') {
    void confirmSeat()
    return
  }
  if (event.key === 'ArrowLeft') col = Math.max(0, col - 1)
  if (event.key === 'ArrowRight') col = Math.min(7, col + 1)
  if (event.key === 'ArrowUp') row = Math.max(0, row - 1)
  if (event.key === 'ArrowDown') row = Math.min(4, row + 1)
  message = ''
  draw()
})
canvas.addEventListener('click', event => {
  const rect = canvas.getBoundingClientRect()
  const x = ((event.clientX - rect.left) * 640) / rect.width - 24
  const y = ((event.clientY - rect.top) * 400) / rect.height - 24
  if (x < 0 || y < 0 || x >= 608 || y >= 320 || x % 76 > 60 || y % 64 > 44) return
  col = Math.floor(x / 76)
  row = Math.floor(y / 64)
  message = ''
  canvas.focus()
  draw()
  void confirmSeat()
})
draw()
canvas.focus()
