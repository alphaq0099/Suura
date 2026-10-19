/**
 * Inline SVG icons.
 *
 * Deliberately not unicode glyphs: Windows renders most media-control characters
 * (⏮ ⏭ ⏸) as colour emoji, which looks broken inside a monochrome toolbar.
 */
interface IconProps {
  size?: number
}

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

export function PlayIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.3-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z" />
    </svg>
  )
}

export function PauseIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6.5" y="5" width="4" height="14" rx="1.2" />
      <rect x="13.5" y="5" width="4" height="14" rx="1.2" />
    </svg>
  )
}

export function PreviousIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="2.4" height="14" rx="1" />
      <path d="M20 6.6v10.8a1 1 0 0 1-1.56.83l-7.6-5.4a1 1 0 0 1 0-1.66l7.6-5.4A1 1 0 0 1 20 6.6z" />
    </svg>
  )
}

export function NextIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="16.6" y="5" width="2.4" height="14" rx="1" />
      <path d="M4 6.6v10.8a1 1 0 0 0 1.56.83l7.6-5.4a1 1 0 0 0 0-1.66l-7.6-5.4A1 1 0 0 0 4 6.6z" />
    </svg>
  )
}

export function FolderIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

export function SearchIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </svg>
  )
}

export function RefreshIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 6v5h-5" />
    </svg>
  )
}

export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      <path d="M6.5 7 7.4 19a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7" />
    </svg>
  )
}

export function CogIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1" />
    </svg>
  )
}

export function MusicIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M9 18V6.8a1 1 0 0 1 .8-1l8-1.6a1 1 0 0 1 1.2 1V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </svg>
  )
}

/**
 * Speaker outline plus stroked waves.
 *
 * A filled body rather than an outlined one: at 18-20px the outline version's
 * single-pixel walls closed up into a blob next to the stroked transport icons.
 */
const VOLUME_WAVE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.9,
  strokeLinecap: 'round' as const
}

function speakerBody() {
  return (
    <path
      d="M12.4 4.3 7.6 8.1H4.5a1 1 0 0 0-1 1v5.8a1 1 0 0 0 1 1h3.1l4.8 3.8a.85.85 0 0 0 1.4-.66V4.96a.85.85 0 0 0-1.4-.66z"
      fill="currentColor"
    />
  )
}

export function VolumeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {speakerBody()}
      <path d="M16 9.2a4.1 4.1 0 0 1 0 5.6" {...VOLUME_WAVE} />
      <path d="M18.9 6.3a7.9 7.9 0 0 1 0 11.4" {...VOLUME_WAVE} />
    </svg>
  )
}

/** One wave only: quiet, but not silent. */
export function VolumeLowIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {speakerBody()}
      <path d="M16 9.2a4.1 4.1 0 0 1 0 5.6" {...VOLUME_WAVE} />
    </svg>
  )
}

export function VolumeMuteIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {speakerBody()}
      <path d="m16.6 9.8 4.8 4.8M21.4 9.8l-4.8 4.8" {...VOLUME_WAVE} />
    </svg>
  )
}

export function RevealIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L11.4 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11.5v4M10.2 13.7 12 15.5l1.8-1.8" />
    </svg>
  )
}

export function SpinnerIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} className="spin" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

/** Filled triangle: the sort indicator in a column header. */
export function SortIcon({ size = 10, direction }: IconProps & { direction: 'asc' | 'desc' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      {direction === 'asc' ? <path d="M6 2.5 10 8H2z" /> : <path d="M6 9.5 2 4h8z" />}
    </svg>
  )
}

export function RepeatIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H19" />
      <path d="m16.5 3.5 3 2.5-3 2.5" />
      <path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H5" />
      <path d="m7.5 20.5-3-2.5 3-2.5" />
    </svg>
  )
}

export function RepeatOneIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M4 12V9.5A3.5 3.5 0 0 1 7.5 6H19" />
      <path d="m16.5 3.5 3 2.5-3 2.5" />
      <path d="M20 12v2.5a3.5 3.5 0 0 1-3.5 3.5H5" />
      <path d="m7.5 20.5-3-2.5 3-2.5" />
      <path d="M12 10v4M11 10.6l1-.6" />
    </svg>
  )
}

export function ShuffleIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M3 6h3.5c1.4 0 2.6.7 3.4 1.8l4.2 6.4c.8 1.1 2 1.8 3.4 1.8H21" />
      <path d="m18.5 13.5 2.5 2.5-2.5 2.5" />
      <path d="M3 18h3.5c1.4 0 2.6-.7 3.4-1.8l.8-1.2" />
      <path d="M14.3 9.2l.8-1.4C15.9 6.7 17.1 6 18.5 6H21" />
      <path d="m18.5 3.5 2.5 2.5-2.5 2.5" />
    </svg>
  )
}

export function QueueIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M4 7h11M4 12h11M4 17h7" />
      <path d="M18.5 11v6.2" />
      <circle cx="17" cy="18" r="1.9" />
    </svg>
  )
}

export function CloseIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

/** A list on a page, with a note: a playlist rather than the queue. */
export function PlaylistIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </svg>
  )
}

/** Adds to something: the "new playlist" and "add to playlist" affordances. */
export function PlusIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/** Renames something. */
export function PencilIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="M14.5 6.5 17.5 9.5" />
    </svg>
  )
}

/** A grip, drawn in the row gutter as the hint that a row can be dragged. */
export function GripIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
    </svg>
  )
}

/** Collapses the full-screen player back into the bar. */
export function ChevronDownIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="m6 9.5 6 6 6-6" />
    </svg>
  )
}
