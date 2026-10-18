import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Track } from '@shared/types'
import { buildArtworkUrl } from '@shared/artwork-url'
import { useArtwork } from '../hooks/useArtwork'
import { MusicIcon } from './Icons'

export interface ArtworkImageProps {
  track: Track | null
  /**
   * The edge of the artwork's box: a number of pixels, or any CSS length for
   * artwork that has to scale with the window (the full-screen player passes a
   * custom property, so a resolved pixel size would freeze it at whatever it was
   * when the window was last that size). With `sizing: 'fit'` it is the *long*
   * edge — the bound on both edges that the cover's own proportions must fit in.
   */
  size?: number | string
  /** Placeholder icon size. Derived from `size` when that is a number. */
  iconSize?: number
  /**
   * An already-resolved cache key. Pass it when the caller has one anyway (for
   * example to paint a blurred backdrop) so the backdrop and the image cannot
   * disagree about which cover is showing.
   */
  artworkKey?: string | null
  className?: string
  /**
   * How the element is sized.
   *
   * `square` (the default) fixes both edges to `size` and lets `object-fit` deal
   * with a cover that is not square. `fit` gives the element the cover's own
   * proportions instead: whichever edge does not fill the box takes what the
   * image's ratio gives it, so a wide cover makes a wide box rather than a square
   * with dead bands above and below it, and the border and shadow trace the
   * artwork rather than a square drawn around it.
   *
   * Only worth asking for where the artwork is large enough for the difference to
   * read. At thumbnail size there is nothing to show and cropping is tidier.
   */
  sizing?: 'square' | 'fit'
}

/**
 * Cover art, with a placeholder when there is none.
 *
 * The placeholder matters: most local libraries have plenty of tracks with no
 * embedded picture, and a broken-image icon or a collapsed row would be worse
 * than a neutral square.
 */
export function ArtworkImage({
  track,
  size = 26,
  iconSize,
  artworkKey,
  className,
  sizing = 'square'
}: ArtworkImageProps) {
  const resolvedKey = useArtwork(track)
  const key = artworkKey !== undefined ? artworkKey : resolvedKey

  // The cover's width / height, as a bare number so CSS can use it for both
  // `aspect-ratio` and a `calc()`. Unknown until the image decodes, which is the
  // reason the box is square until then: `--art-scale` falls back to 1, so the
  // artwork is reserved at its full size and then settles into its own shape
  // instead of collapsing to nothing and jumping.
  const [scale, setScale] = useState<number | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)

  /**
   * Reads the cover's proportions off a decoded image.
   *
   * `complete` is checked as well as the load event because the two do not cover
   * the same ground: an image that is already decoded — a cached cover when the
   * element is reused rather than remounted — fires no load event at all, and the
   * box would silently stay square in `fit` mode. Whichever of the two notices
   * first wins; the state setter bails out on an unchanged value.
   */
  useEffect(() => {
    if (sizing !== 'fit' || scale !== null) return
    const element = imageRef.current
    if (element?.complete && element.naturalWidth > 0 && element.naturalHeight > 0) {
      setScale(element.naturalWidth / element.naturalHeight)
    }
  }, [sizing, scale, key])

  const classes = className ? `artwork ${className}` : 'artwork'
  const dimension = typeof size === 'number' ? `${size}px` : size
  const icon = iconSize ?? (typeof size === 'number' ? Math.round(size * 0.55) : 32)

  if (!key) {
    // The placeholder has no proportions to take, so it stays square whatever
    // `sizing` says.
    return (
      <span
        className={`${classes} artwork-empty`}
        style={{ width: dimension, height: dimension }}
        aria-hidden="true"
        data-artwork="none"
      >
        <MusicIcon size={icon} />
      </span>
    )
  }

  // In `fit` mode the box is left to the stylesheet, which sizes it from
  // `--art-scale`; a fixed width here would win over that and square it again.
  const style: CSSProperties =
    sizing === 'fit'
      ? ({ '--art-scale': scale ? String(scale) : undefined } as CSSProperties)
      : { width: dimension, height: dimension }

  return (
    <img
      className={classes}
      style={style}
      ref={imageRef}
      src={buildArtworkUrl(key)}
      alt={track?.album ? `${track.album} cover` : ''}
      draggable={false}
      data-artwork="ready"
      data-sizing={sizing}
      onLoad={
        sizing === 'fit'
          ? (event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget
              if (naturalWidth > 0 && naturalHeight > 0) setScale(naturalWidth / naturalHeight)
            }
          : undefined
      }
    />
  )
}
