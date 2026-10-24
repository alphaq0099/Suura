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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-3v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H4.3v-3h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h3v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v3h-.2a1.7 1.7 0 0 0-1.6 1Z" />
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

export function LinkIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M10.2 13.8a4 4 0 0 0 5.6 0l2.6-2.6a4 4 0 0 0-5.6-5.6l-1.2 1.2" />
      <path d="M13.8 10.2a4 4 0 0 0-5.6 0l-2.6 2.6a4 4 0 0 0 5.6 5.6l1.2-1.2" />
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
      <path d="m15.5 14 4 2.8-4 2.8z" fill="currentColor" />
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
      <path d="M4 7h9M4 12h9M4 17h7" />
      <path d="M17.5 6v8.1" />
      <circle cx="15.8" cy="16" r="1.9" />
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

/** The paste button: a clipboard, so it reads as "take what is copied". */
export function ClipboardIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M9 4.5H7.5A1.5 1.5 0 0 0 6 6v13a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V6a1.5 1.5 0 0 0-1.5-1.5H15" />
      <rect x="9" y="2.8" width="6" height="3.4" rx="1.2" />
    </svg>
  )
}

/** Copying a link back out of the history. */
export function CopyIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" />
    </svg>
  )
}

/** A down arrow into a tray: keeping a link in the local library. */
export function DownloadIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M12 4v10" />
      <path d="m8 10.5 4 4 4-4" />
      <path d="M5 18.5h14" />
    </svg>
  )
}

/** The same tray with a tick: this link is already in the library. */
export function CheckIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  )
}

/** A compact waveform: the brand mark in the Modern sidebar set. */
export function BrandMarkIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M4 14v-4M8 17V7M12 20V4M16 17V7M20 14v-4" />
    </svg>
  )
}

/** A shelf of books: Library in the Modern sidebar set. */
export function LibraryIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M4 19.5h16" />
      <path d="M6 16.5V7.5A1.5 1.5 0 0 1 7.5 6H9v10.5" />
      <path d="M10.5 16.5v-11h3A1.5 1.5 0 0 1 15 7v9.5" />
      <path d="m17.2 6.2 2.4-.6 2 9.8-2.4.6z" />
    </svg>
  )
}

/** A play badge: YouTube in the Modern sidebar set. */
export function YouTubeIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5.5" width="18" height="13" rx="4" {...STROKE} />
      <path d="m10 9.2 5.2 2.8-5.2 2.8z" fill="currentColor" />
    </svg>
  )
}

/** A card with a music note: Playlists in the Modern sidebar set. */
export function ListMusicIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M9.5 16V7.8l6-1.2v8.2" />
      <circle cx="7.7" cy="16.2" r="1.8" />
      <circle cx="13.7" cy="14.8" r="1.8" />
    </svg>
  )
}

/** A playing row above the rest: Queue in the Modern sidebar set. */
export function QueueModernIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="6" rx="1.5" />
      <path d="m7 6 2.6 1.5L7 9z" fill="currentColor" />
      <path d="M3.5 14.5h17M3.5 18h11" />
    </svg>
  )
}

/** Horizontal sliders: Settings in the Modern sidebar set. */
export function SlidersIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  )
}

/** The overflow menu on a row. */
export function MoreIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18.5" cy="12" r="1.6" />
    </svg>
  )
}

/** Details: the technical sheet behind a track. */
export function InfoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6v.1" />
    </svg>
  )
}
