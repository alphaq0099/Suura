import { useEffect, useRef, type RefObject } from 'react'

/**
 * Volume by wheel, for the elements that stand in for the volume control.
 *
 * A notch is five percent and holding Shift makes it one, which is the slider's
 * own step. The listener is native and non-passive because React's `onWheel` is
 * passive, and a passive listener is not allowed to keep whatever sits
 * underneath from scrolling. Level and setter are read through refs so the
 * listener is attached once and still sees the current ones.
 *
 * Returns the ref for the element that should answer the wheel.
 */
export function useWheelVolume(
  volume: number,
  onVolume: (volume: number) => void
): RefObject<HTMLDivElement | null> {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const volumeRef = useRef(volume)
  const onVolumeRef = useRef(onVolume)

  useEffect(() => {
    volumeRef.current = volume
  }, [volume])

  useEffect(() => {
    onVolumeRef.current = onVolume
  }, [onVolume])

  useEffect(() => {
    const box = boxRef.current
    if (!box) return undefined

    const handleWheel = (event: WheelEvent): void => {
      // The bar's queue button shares this cluster, and a wheel over it is not a
      // volume gesture, so it is left to do nothing.
      if ((event.target as HTMLElement | null)?.closest('.queue-button')) return
      event.preventDefault()
      const step = event.shiftKey ? 0.01 : 0.05
      const next = volumeRef.current + (event.deltaY < 0 ? step : -step)
      const clamped = Math.min(1, Math.max(0, Math.round(next * 100) / 100))
      if (clamped === volumeRef.current) return
      onVolumeRef.current(clamped)
    }

    box.addEventListener('wheel', handleWheel, { passive: false })
    return () => box.removeEventListener('wheel', handleWheel)
  }, [])

  return boxRef
}
