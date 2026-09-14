export const defaultPreviewZoom = 100
export const minPreviewZoom = 50
export const maxPreviewZoom = 200
export const previewZoomStep = 10

export function nextPreviewZoom(current: number, deltaY: number): number {
  if (deltaY === 0) return current
  const next = current + (deltaY < 0 ? previewZoomStep : -previewZoomStep)
  return Math.min(maxPreviewZoom, Math.max(minPreviewZoom, next))
}
