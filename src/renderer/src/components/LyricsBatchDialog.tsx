import { useEffect, useMemo, useRef } from 'react'
import type { LyricsBatchItem, LyricsBatchMatch } from '@shared/types'
import { formatDuration } from '@shared/format'
import { useLyricsBatch } from '../hooks/useLyricsBatch'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { CloseIcon, LyricsIcon, SpinnerIcon } from './Icons'

const CONFIDENCE_LABEL: Record<LyricsBatchMatch['confidence'], string> = {
  strong: 'Strong match',
  likely: 'Likely match',
  weak: 'Possible match'
}

const PROVIDER_LABEL: Record<LyricsBatchMatch['provider'], string> = {
  lrclib: 'LRCLIB',
  genius: 'Genius'
}

export interface LyricsBatchDialogProps {
  /** The selected local tracks to scan. Streams are never included. */
  trackIds: number[]
  onClose: () => void
}

function summaryLine(item: LyricsBatchItem): string {
  if (item.status === 'skipped') return item.message ?? 'Already has lyrics.'
  if (item.status === 'no-match') return item.message ?? 'No close match.'
  return item.message ?? 'Could not look this up.'
}

/**
 * The review half of batch lyrics.
 *
 * The scan has already happened in the main process; this shows what it found,
 * lets the user untick anything they do not want, and only then stores it. The
 * "write into files" box is off by default: storing a copy is reversible, while
 * rewriting every file in a selection is a bigger promise, even with backups.
 */
export function LyricsBatchDialog(props: LyricsBatchDialogProps) {
  const { trackIds, onClose } = props
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useDialogFocus(dialogRef)
  const batch = useLyricsBatch(trackIds)
  const { phase, progress, snapshot, selected, result, undoResult } = batch

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const counts = useMemo(() => {
    const items = snapshot?.items ?? []
    return {
      matches: items.filter((item) => item.status === 'match').length,
      skipped: items.filter((item) => item.status === 'skipped').length,
      noMatch: items.filter((item) => item.status === 'no-match').length,
      failed: items.filter((item) => item.status === 'failed').length,
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
        className="details-dialog lyrics-batch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lyrics-batch-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          close()
        }}
      >
        <header className="details-head">
          <LyricsIcon size={28} />
          <div className="details-titles">
            <h2 id="lyrics-batch-title">Fetch missing lyrics</h2>
            <p className="subtitle">
              {phase === 'scanning'
                ? `Looking through ${progress?.total ?? trackIds.length} ${
                    (progress?.total ?? trackIds.length) === 1 ? 'track' : 'tracks'
                  }…`
                : phase === 'review'
                  ? `${counts.matches} ${counts.matches === 1 ? 'match' : 'matches'} · ${counts.skipped} already have lyrics · ${counts.noMatch} without a match`
                  : 'Nothing is written until you choose.'}
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

                <ul className="auto-tag-list batch-list" aria-label="Lyrics matches">
                  {matches.map((item) => (
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
                            {item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ''}
                          </span>
                        </span>
                        {item.match ? (
                          <span className="auto-tag-score">
                            <span className={`auto-tag-badge ${item.match.confidence}`}>
                              {CONFIDENCE_LABEL[item.match.confidence]}
                            </span>
                            <span className="subtitle">
                              {PROVIDER_LABEL[item.match.provider]}
                              {item.match.synced ? ' · timed' : ' · plain text'}
                            </span>
                          </span>
                        ) : null}
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="auto-tag-status" role="status">
                Nothing new to fetch. Every track either already has lyrics or came back without a
                close match.
              </p>
            )}

            {others.length > 0 ? (
              <details className="batch-skipped">
                <summary>
                  Not fetching {others.length} {others.length === 1 ? 'track' : 'tracks'}
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

            <label className="lyrics-batch-write">
              <input
                type="checkbox"
                checked={batch.writeToFile}
                onChange={(event) => batch.setWriteToFile(event.target.checked)}
              />
              <span>
                <strong>Also write each one into its file's tags</strong>
                <span className="field-note">
                  Rewrites the file, not just the library. Undo puts the file back from the backup
                  Suura keeps.
                </span>
              </span>
            </label>

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
                {batch.writeToFile
                  ? `Store and write ${selected.size}`
                  : `Store ${selected.size}`}
              </button>
            </footer>
          </>
        ) : null}

        {phase === 'applying' ? (
          <p className="auto-tag-status" role="status">
            <SpinnerIcon size={16} />
            <span>
              {batch.writeToFile ? 'Storing and writing lyrics…' : 'Storing lyrics…'}
            </span>
          </p>
        ) : null}

        {phase === 'result' && result ? (
          <>
            <div className="batch-result" role="status">
              <p>
                <strong>{result.stored}</strong> stored in the library
                {result.written > 0 ? (
                  <>
                    {' '}
                    · <strong>{result.written}</strong> written into files
                  </>
                ) : null}
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
                  Undone: <strong>{undoResult.removed}</strong> removed ·{' '}
                  <strong>{undoResult.restored}</strong> files restored
                  {undoResult.skipped > 0 ? ` · ${undoResult.skipped} left alone` : ''}
                </p>
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
                    : 'Remove the stored copies and restore any files that were written.'
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
