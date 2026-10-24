import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/**
 * A single line that reveals its full value by scrolling while hovered.
 *
 * The tables give Artist and Channel a bounded width, so a long uploader name
 * has to truncate. A native tooltip is easy to miss and the title column is the
 * one that should keep the room; this keeps the metadata readable without
 * widening the table. The distance is measured from the real rendered text, so
 * short values never move and long ones stop exactly at their last character.
 *
 * The animation is CSS-driven once the distance is known, which lets the
 * app-wide reduced-motion rules switch it off with everything else.
 */
export function ScrollingText(props: {
  text: string
  className?: string
  title?: string
}) {
  const { text, className, title } = props
  const outerRef = useRef<HTMLSpanElement | null>(null)
  const innerRef = useRef<HTMLSpanElement | null>(null)
  const [distance, setDistance] = useState(0)

  useLayoutEffect(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return

    const measure = (): void => {
      const next = Math.max(0, Math.ceil(inner.scrollWidth - outer.clientWidth))
      setDistance((previous) => (previous === next ? previous : next))
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [text])

  const style =
    distance > 0
      ? ({
          '--scroll-distance': `${-distance}px`,
          '--scroll-duration': `${Math.min(12, Math.max(2.4, distance / 28))}s`
        } as CSSProperties)
      : undefined

  return (
    <span
      ref={outerRef}
      className={['scrolling-text', distance > 0 ? 'is-overflowing' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      style={style}
      title={title ?? text}
    >
      <span ref={innerRef} className="scrolling-text-inner">
        {text}
      </span>
    </span>
  )
}
