import type {
  TagBatchChange,
  TagBatchField,
  TagBatchMode,
  TagCandidate,
  Track,
  TrackTagFields
} from './types'

/**
 * What a batch tag write would change, and what it is allowed to.
 *
 * This is the safety rule of the feature, so it is pure and lives beside the
 * ranking rules rather than in the dialog: a field the file already fills in is
 * never proposed for a fill, and a field whose value already matches is not a
 * change at all. The review dialog only renders what these functions decide,
 * and the batch re-runs them against the live row at apply time, so a row
 * edited between the scan and the write cannot be overwritten by accident.
 */

/** The text groups, in the order the review lists them. */
type TagBatchTextField = Extract<
  TagBatchField,
  'title' | 'artist' | 'albumArtist' | 'album' | 'genre'
>

/** `3 of 12`, `3`, or blank — the same wording the tag editor uses. */
export function positionText(no: number | null, total: number | null): string {
  if (no === null || no <= 0) return ''
  return total !== null && total > 0 ? `${no} of ${total}` : String(no)
}

function textOf(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

function textWrite(field: TagBatchTextField, to: string): TrackTagFields {
  switch (field) {
    case 'title':
      return { title: to }
    case 'artist':
      return { artist: to }
    case 'albumArtist':
      return { albumArtist: to }
    case 'album':
      return { album: to }
    case 'genre':
      return { genre: to }
  }
}

function textChange(
  field: TagBatchTextField,
  label: string,
  fromValue: string | null,
  toValue: string | null
): TagBatchChange | null {
  const to = textOf(toValue)
  if (!to) return null
  const from = textOf(fromValue)
  if (from === to) return null
  return { field, label, from, to, fills: from === null, fields: textWrite(field, to) }
}

/**
 * Every difference between a row and a match, in the order the dialog lists
 * them.
 *
 * A field the match has nothing for is not a change: the finder is allowed to
 * be silent about a genre, and silence must not clear one. A field that already
 * says the same thing is not a change either, which is what makes a fully
 * matched row a skip rather than a rewrite.
 */
export function tagBatchChanges(track: Track, candidate: TagCandidate): TagBatchChange[] {
  const changes: TagBatchChange[] = []

  for (const [field, label, from, to] of [
    ['title', 'Title', track.title, candidate.title],
    ['artist', 'Artist', track.artist, candidate.artist],
    ['albumArtist', 'Album artist', track.albumArtist, candidate.albumArtist],
    ['album', 'Album', track.album, candidate.album],
    ['genre', 'Genre', track.genre, candidate.genre]
  ] as const) {
    const change = textChange(field, label, from, to)
    if (change) changes.push(change)
  }

  const yearTo = candidate.year !== null && candidate.year > 0 ? String(candidate.year) : null
  if (yearTo) {
    const yearFrom = track.year !== null && track.year > 0 ? String(track.year) : null
    if (yearFrom !== yearTo) {
      changes.push({
        field: 'year',
        label: 'Year',
        from: yearFrom,
        to: yearTo,
        fills: yearFrom === null,
        fields: { year: candidate.year }
      })
    }
  }

  const trackTo = positionText(candidate.trackNo, candidate.trackTotal)
  if (trackTo) {
    const trackFrom = positionText(track.trackNo, track.trackTotal) || null
    if (trackFrom !== trackTo) {
      changes.push({
        field: 'track',
        label: 'Track',
        from: trackFrom,
        to: trackTo,
        fills: trackFrom === null,
        // A position is one frame in the container, so both halves travel
        // together, exactly as the tag editor sends them.
        fields: { trackNo: candidate.trackNo, trackTotal: candidate.trackTotal }
      })
    }
  }

  const discTo = positionText(candidate.discNo, candidate.discTotal)
  if (discTo) {
    const discFrom = positionText(track.discNo, track.discTotal) || null
    if (discFrom !== discTo) {
      changes.push({
        field: 'disc',
        label: 'Disc',
        from: discFrom,
        to: discTo,
        fills: discFrom === null,
        fields: { discNo: candidate.discNo, discTotal: candidate.discTotal }
      })
    }
  }

  return changes
}

/** The changes a mode would actually write. */
export function tagBatchActionable(
  changes: readonly TagBatchChange[],
  mode: TagBatchMode
): TagBatchChange[] {
  return mode === 'replace' ? [...changes] : changes.filter((change) => change.fills)
}

/** The tag write for a mode: empty when there is nothing to do. */
export function tagBatchFields(
  changes: readonly TagBatchChange[],
  mode: TagBatchMode
): TrackTagFields {
  const fields: TrackTagFields = {}
  for (const change of tagBatchActionable(changes, mode)) Object.assign(fields, change.fields)
  return fields
}

/** One line per change, for the review row: `Album: new` or `Artist: A → B`. */
export function describeTagBatchChange(change: TagBatchChange): string {
  return change.from === null
    ? `${change.label}: ${change.to}`
    : `${change.label}: ${change.from} → ${change.to}`
}
