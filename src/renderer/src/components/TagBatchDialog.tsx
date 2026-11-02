import { useEffect, useMemo, useRef } from 'react'
import type { TagBatchItem, TagBatchMatch, TagBatchMode } from '@shared/types'
import { formatDuration } from '@shared/format'
import { describeTagBatchChange, tagBatchActionable } from '@shared/tag-batch'
import { useTagBatch } from '../hooks/useTagBatch'
import { CloseIcon, SpinnerIcon, TagIcon } from './Icons'

const CONFIDENCE_LABEL: Record<TagBatchMatch['confidence'], string> = {
  strong: 'Strong match',
  likely: 'Likely match',
  weak: 'Possible match'
}

const PROVIDER_LABEL: Record<TagBatchMatch['provider'], string> = {
  itunes: 'iTunes',
  musicbrainz: 'MusicBrainz'
}

/** How many field changes a review row spells out before counting the rest. */
const CHANGES_SHOWN = 3

export interface TagBatchDialogProps {
  /** The selected local tracks to scan. Streams are never included. */
  trackIds: number[]
  onClose: () => void
}

function changesFor(item: TagBatchItem, mode: TagBatchMode): string[] {
  if (!item.match) return []
  return tagBatchActionable(item.match.changes, mode).map(describeTagBatchChange)
}

function changesText(item: TagBatchItem, mode: TagBatchMode): string {
  const lines = changesFor(item, mode)
  if (lines.length === 0) return mode === 'fill' ? 'Nothing to fill' : 'Nothing to change'
  const shown = lines.slice(0, CHANGES_SHOWN)
  const rest = lines.length - shown.length
  return rest > 0 ? `${shown.join(' · ')} · +${rest} more` : shown.join(' · ')
}

function summaryLine(item: TagBatchItem): string {
  if (item.status === 'skipped') return item.message ?? 'Already matches.'
  if (item.status === 'no-match') return item.message ?? 'No close match.'
  return item.message ?? 'Could not look this up.'
}

/**
 * The review half of batch tags.
 *
 * The scan has already happened in the main process; this shows what came back,
 * what each match would change, and lets the user untick anything they do not
 * want. Filling blank fields is the default; replacing a value the file already
 * has is a checkbox, because that is the one choice here that destroys
 * something. Every write is reversible from the backup the tag writer keeps.
 */
export function TagBatchDialog(props: TagBatchDialogProps) {
  const { trackIds, onClose } = props
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const batch = useTagBatch(trackIds)
  const { phase, progress, snapshot, selected, mode, result, undoResult } = batch

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const counts = useMemo(() => {
    const items = snapshot?.items ?? []
    return {
      matches: items.filter((item) => item.status === 'match').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      noMatch: items.filter((item) => item.status === 'no-match').length,
      total: items.length
    }
  }, [snapshot])

  const matches = useMemo(
    () => (snapshot?.items ?? []).filter((item) => item.status === 'match'),
    [snapshot]
  )
  const others = useMemo(
    () => (snapshot?.items ?? []).filter((item) => item.status !== 'match'),
    [snapshot]
  )
  const providerWarnings = useMemo(
    () =>
      (snapshot?.providers ?? [])
        .filter((report) => !report.ok && report.message)
        .map((report) => report.message as string),
    [snapshot]
  )

  const busy = phase === 'scanning' || phase === 'applying' || batch.undoing
  const canClose = phase !== 'applying' && !batch.undoing

  const close = (): void => {
    if (canClose) onClose()
  }

  return (
    <div
      className="details-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={dialogRef}
        className="details-dialog tag-batch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-batch-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          close()
        }}
      >
        <header className="details-head">
          <TagIcon size={28} />
          <div className="details-titles">
            <h2 id="tag-batch-title">Fix tags</h2>
            <p className="subtitle">
              {phase === 'scanning'
                ? `Looking through ${progress?.total ?? trackIds.length} ${
                    (progress?.total ?? trackIds.length) === 1 ? 'track' : 'tracks'
                  }…`
                : phase === 'review'
                  ? `${counts.matches} ${counts.matches === 1 ? 'match' : 'matches'} · ${counts.skipped} already match · ${counts.noMatch} without a match`
                  : phase === 'applying'
                    ? 'Writing the tags you chose…'
                    : 'Every write can be undone from the backup Suura kept.'}
            </p>
          </div>
          <button
            type="button"
            className="icon-button subtle details-close"
            title="Close (Esc)"
            aria-label="Close"
            onClick={close}
            disabled={!canClose}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        {phase === 'scanning' ? (
          <div className="batch-progress" role="status">
            <SpinnerIcon size={16} />
            <div className="batch-progress-text">
              <p>
                {progress
                  ? `${progress.scanned} of ${progress.total} checked`
                  : 'Starting the scan…'}
              </p>
              {progress && progress.total > 0 ? (
                <progress value={progress.scanned} max={progress.total} />
              ) : null}
              {progress?.currentTitle ? (
                <p className="field-note">Now: {progress.currentTitle}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {phase === 'review' && snapshot ? (
          <>
            {snapshot.message ? (
              <p className="banner error" role="alert">
                {snapshot.message}
              </p>
            ) : null}
            {providerWarnings.length > 0 ? (
              <p className="batch-warning" role="status">
                {providerWarnings.join(' ')}
              </p>
            ) : null}
            {batch.error ? (
              <p className="banner error" role="alert">
                {batch.error}
              </p>
            ) : null}

            <label className="tag-batch-mode">
              <input
                type="checkbox"
                checked={mode === 'replace'}
                onChange={(event) => batch.setMode(event.target.checked ? 'replace' : 'fill')}
              />
              <span>
                <strong>Also replace fields that already have a value</strong>
                <span className="field-note">
                  {mode === 'replace'
                    ? 'Every field the match disagrees with is rewritten, titles included. Undo puts the file back from the backup Suura keeps.'
                    : 'Off: only the fields this file leaves empty are filled. Nothing already written is touched.'}
                </span>
              </span>
            </label>

            {matches.length > 0 ? (
              <>
                <div className="batch-tools">
                  <button type="button" onClick={() => batch.selectAll(true)}>
                    Select all
                  </button>
                  <button type="button" onClick={() => batch.selectAll(false)}>
                    Select none
                  </button>
                  <span className="field-note">
                    {selected.size} of {matches.length} chosen
                  </span>
                </div>

                <ul className="auto-tag-list batch-list" aria-label="Tag matches">
                  {matches.map((item) => {
                    const actionable = changesFor(item, mode).length > 0
                    return (
                      <li key={item.id}>
                        <label className="auto-tag-match batch-match">
                          <input
                            type="checkbox"
                            checked={selected.has(item.id)}
                            onChange={() => batch.toggle(item.id)}
                          />
                          <span className="auto-tag-match-text">
                            <strong>{item.title}</strong>
                            <span className="subtitle">
                              {[item.artist ?? 'Unknown artist', item.album]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                            <span
                              className={`tag-batch-changes${actionable ? '' : ' quiet'}`}
                            >
                              {changesText(item, mode)}
                            </span>
                          </span>
                          {item.match ? (
                            <span className="auto-tag-score">
                              <span className={`auto-tag-badge ${item.match.confidence}`}>
                                {CONFIDENCE_LABEL[item.match.confidence]}
                              </span>
                              <span className="subtitle">
                                {PROVIDER_LABEL[item.match.provider]}
                                {item.match.durationMs
                                  ? ` · ${formatDuration(item.match.durationMs)}`
                                  : ''}
                              </span>
                            </span>
                          ) : null}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </>
            ) : (
              <p className="auto-tag-status" role="status">
                Nothing to fix. Every track either already agrees with its best match or came back
                without a close one.
              </p>
            )}

            {others.length > 0 ? (
              <details className="batch-skipped">
                <summary>
                  Not writing {others.length} {others.length === 1 ? 'track' : 'tracks'}
                </summary>
                <ul>
                  {others.map((item) => (
                    <li key={item.id}>
                      <strong>{item.title}</strong>
                      <span>{summaryLine(item)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <footer className="details-foot">
              <button type="button" onClick={close} disabled={!canClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void batch.apply()}
                disabled={selected.size === 0 || busy}
              >
                {selected.size === 1 ? 'Write 1 file' : `Write ${selected.size} files`}
              </button>
            </footer>
          </>
        ) : null}

        {phase === 'applying' ? (
          <p className="auto-tag-status" role="status">
            <SpinnerIcon size={16} />
            <span>Writing tags…</span>
          </p>
        ) : null}

        {phase === 'result' && result ? (
          <>
            <div className="batch-result" role="status">
              <p>
                <strong>{result.written}</strong>{' '}
                {result.written === 1 ? 'file rewritten' : 'files rewritten'}
                {result.skipped > 0 ? ` · ${result.skipped} had nothing to write` : ''}
              </p>
              {result.failed.length > 0 ? (
                <p className="banner error" role="alert">
                  {result.failed.length}{' '}
                  {result.failed.length === 1 ? 'track needs attention' : 'tracks need attention'}:
                  the first is “{result.failed[0]?.title}” — {result.failed[0]?.message}
                </p>
              ) : null}
            </div>

            {undoResult ? (
              <div className="batch-result" role="status">
                <p>
                  Undone: <strong>{undoResult.restored}</strong>{' '}
                  {undoResult.restored === 1 ? 'file restored' : 'files restored'}
                  {undoResult.skipped > 0 ? ` · ${undoResult.skipped} left alone` : ''}
                </p>
                {undoResult.skipped > 0 ? (
                  <p className="field-note">
                    Tracks edited after the batch, or written without a backup, were left alone.
                  </p>
                ) : null}
                {undoResult.failed.length > 0 ? (
                  <p className="banner error" role="alert">
                    {undoResult.failed.length}{' '}
                    {undoResult.failed.length === 1 ? 'track' : 'tracks'} could not be undone, such
                    as “{undoResult.failed[0]?.title}”: {undoResult.failed[0]?.message}
                  </p>
                ) : null}
              </div>
            ) : null}

            {batch.error ? (
              <p className="banner error" role="alert">
                {batch.error}
              </p>
            ) : null}

            <footer className="details-foot">
              <button
                type="button"
                onClick={() => void batch.undo()}
                disabled={batch.undoing || undoResult !== null}
                title={
                  undoResult
                    ? 'This batch has already been undone.'
                    : 'Put every file back from the backup taken before it was written.'
                }
              >
                {batch.undoing ? <SpinnerIcon size={14} /> : null}
                <span>Undo</span>
              </button>
              <button type="button" className="primary" onClick={close} disabled={!canClose}>
                Done
              </button>
            </footer>
          </>
        ) : null}
      </div>
    </div>
  )
}
