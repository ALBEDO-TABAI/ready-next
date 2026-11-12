/** A new card from the 新建 menu: 260 wide, centred on the clicked world point (a little above it). */
export const newCardFrame = (at: { x: number; y: number }, height: number) => ({ id: crypto.randomUUID(), x: Math.round(at.x - 130), y: Math.round(at.y - 40), width: 260, height })
