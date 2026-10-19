import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Track } from '@shared/types'
import { api, messageOf } from '../api'
import { SpinnerIcon } from './Icons'

export interface PlayLinkDialogProps {
  open: boolean
  onClose: () => void
  onPlay: (track: Track) => void
}

/**
 * Paste-a-link entry point for M3 streaming.
 *
 * Resolving takes 7-10 s, which is too long for a silently frozen button, so
 * the dialog stays open with a spinner and an inline error instead of handing
 * the failure back to the library banner. Closing it cancels the *intent* even
 * if the sidecar has already been started; the work is harmless, and the next
 * paste of the same link is answered from the session cache.
 */
export function PlayLinkDialog({ open, onClose, onPlay }: PlayLinkDialogProps) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const requestRef = useRef(0)

  const close = (): void => {
    // A resolve that finishes after closing must not start playback.
    requestRef.current += 1
    onClose()
  }

  useEffect(() => {
    if (!open) return
    setUrl('')
    setError(null)
    setBusy(false)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Capture phase: the global shortcut handler also listens for Escape and
      // would clear the library search behind the dialog. Immediate propagation
      // stops also matters because both listeners sit on `window`.
      event.preventDefault()
      event.stopImmediatePropagation()
      requestRef.current += 1
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  if (!open) return null

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const link = url.trim()
    if (!link) return

    const ticket = ++requestRef.current
    setBusy(true)
    setError(null)
    try {
      const track = await api.addYoutubeLink(link)
      if (requestRef.current !== ticket) return
      onPlay(track)
      close()
    } catch (cause) {
      if (requestRef.current === ticket) setError(messageOf(cause))
    } finally {
      if (requestRef.current === ticket) setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <form
        className="play-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="play-link-title"
        aria-describedby="play-link-hint"
        onSubmit={(event) => void submit(event)}
      >
        <h2 id="play-link-title">Play a link</h2>
        <p id="play-link-hint">Paste a YouTube video link. It streams only — nothing is saved to your library.</p>
        <input
          ref={inputRef}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://www.youtube.com/watch?v=…"
          aria-label="YouTube link"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={busy}
        />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || url.trim().length === 0}>
            {busy ? (
              <>
                <SpinnerIcon />
                Resolving…
              </>
            ) : (
              'Play'
            )}
          </button>
        </div>
      </form>
    </div>
  )
}
