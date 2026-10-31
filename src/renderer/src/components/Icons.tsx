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
      <path d="M7.4 4.7v14.6a1.15 1.15 0 0 0 1.76.97l11.1-7.3a1.15 1.15 0 0 0 0-1.94L9.16 3.73A1.15 1.15 0 0 0 7.4 4.7z" />
    </svg>
  )
}

export function PauseIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="5.6" y="4.4" width="5" height="15.2" rx="1.4" />
      <rect x="13.4" y="4.4" width="5" height="15.2" rx="1.4" />
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

/** A clock wound backwards: Recently played, as a history rather than a play button. */
export function HistoryIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M3.6 12a8.4 8.4 0 1 0 2.5-6" />
      <path d="M3.5 4.5v4.2h4.2" />
      <path d="M12 8.2V12l2.8 1.7" />
    </svg>
  )
}

/** A music note with a plus: a file that has just joined the library. */
export function NewMusicIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M8.6 18V7.4a1 1 0 0 1 .8-1l5.2-1a1 1 0 0 1 1.2 1v8.2" />
      <circle cx="6.1" cy="18" r="2.5" />
      <circle cx="14.8" cy="15.6" r="2.5" />
      <path d="M19 3.4v5M16.5 5.9h5" />
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

/** Home: the dashboard above the library views. */
export function HomeIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="m3.8 10.4 7.4-6.1a1.3 1.3 0 0 1 1.6 0l7.4 6.1" />
      <path d="M5.8 9.2V19a1.2 1.2 0 0 0 1.2 1.2h10a1.2 1.2 0 0 0 1.2-1.2V9.2" />
      <path d="M9.8 20.2v-5.4h4.4v5.4" />
    </svg>
  )
}

/** A disc, used beside album counts and in album cards. */
export function DiscIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" opacity=".45" />
    </svg>
  )
}

/** An artist: a head and shoulders. */
export function ArtistIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.8 20c.5-3.6 3.4-6 7.2-6s6.7 2.4 7.2 6" />
    </svg>
  )
}

export function ArrowLeftIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
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

/** A window with a smaller window inside it: the compact player. */
export function MiniPlayerIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="12.5" y="11" width="6" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function ExpandIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
      <path d="M4 9l5-5M20 9l-5-5M4 15l5 5M20 15l-5 5" />
    </svg>
  )
}

/**
 * Two chevrons pointing left: "give this the whole window" from a panel that
 * already sits on the right edge. One chevron reads as "back"; two read as
 * "expand", which is what the footer button does.
 */
export function DoubleChevronLeftIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="m11.5 6-6 6 6 6M18.5 6l-6 6 6 6" />
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

/** Steps a horizontal shelf one page back. */
export function ChevronLeftIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="m14.5 6-6 6 6 6" />
    </svg>
  )
}

/** Steps a horizontal shelf one page forward. */
export function ChevronRightIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <path d="m9.5 6 6 6-6 6" />
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

/** Scissors: cutting the selection out of a text field. */
export function CutIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
      <path d="M8.4 15.4 18 4.5M15.6 15.4 6 4.5" />
    </svg>
  )
}

/** A dashed box around a filled one: selecting everything in a field. */
export function SelectAllIcon({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 2.4" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />
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

/** A microphone: the lyrics panel, not a page and not the queue. */
export function LyricsIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...STROKE} aria-hidden="true">
      <rect x="9" y="2.8" width="6" height="10.4" rx="3" />
      <path d="M5.6 11a6.4 6.4 0 0 0 12.8 0" />
      <path d="M12 17.4V21M9 21h6" />
    </svg>
  )
}

/** A playing row above the rest: Queue in the Modern sidebar set. */
export function QueueModernIcon({ size = 18 }: IconProps) {  return (
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

/**
 * Upright faders: the equalizer, not the settings sliders.
 *
 * The old trigger reused `SlidersIcon`, so it read as a second way into
 * Settings and sat next to Queue with no identity of its own. Stems with
 * knobs at different heights match the panel it opens and cannot be mistaken
 * for either neighbour.
 */
export function EqualizerIcon({ size = 18 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 4v16M12 4v16M18 4v16" {...STROKE} opacity=".45" />
      <rect x="4.4" y="12" width="3.2" height="3.2" rx="1" fill="currentColor" />
      <rect x="10.4" y="6" width="3.2" height="3.2" rx="1" fill="currentColor" />
      <rect x="16.4" y="14" width="3.2" height="3.2" rx="1" fill="currentColor" />
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
