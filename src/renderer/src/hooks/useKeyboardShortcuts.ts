import { useEffect, useRef } from 'react'

/** Seek step for the arrow keys, and the bigger step with Shift held. */
const SEEK_STEP_MS = 5_000
const SEEK_STEP_LARGE_MS = 30_000
/** Volume step, as a fraction of full scale. */
const VOLUME_STEP = 0.05

export interface ShortcutHandlers {
  toggle: () => void
  next: () => void
  previous: () => void
  seekBy: (deltaMs: number) => void
  setVolume: (volume: number) => void
  volume: () => number
  /** Called on Escape when focus is not in a text field. */
  onEscape?: () => void
  focusSearch: () => void
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Whether the browser will already turn Space/Enter into a click here.
 *
 * Without this check a press of Space on a focused button both activates the
 * button and runs the global shortcut, and the two cancel out — which is why
 * Space used to do nothing after clicking a transport button.
 */
function isActivatable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('button, a[href], [role="button"]') !== null
}

/**
 * Global keyboard shortcuts.
 *
 * One listener on `window`, with the handlers read through a ref so the listener
 * is installed once. Components that need to own a key (the track list owns the
 * arrow keys for row navigation) stop propagation, which keeps the two from
 * fighting over the same key.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers)

  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  useEffect(() => {
    // Remembers the level to come back to after a mute.
    let volumeBeforeMute = 0.8

    const onKeyDown = (event: KeyboardEvent): void => {
      const current = handlersRef.current
      const typing = isTypingTarget(event.target)

      if (typing) {
        // Only Escape does anything while typing: it leaves the field.
        if (event.key === 'Escape' && event.target instanceof HTMLElement) {
          event.target.blur()
        }
        return
      }

      if ((event.ctrlKey || event.metaKey) && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault()
        current.focusSearch()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return

      if (event.key === 'Escape') {
        current.onEscape?.()
        return
      }

      switch (event.key) {
        case ' ':
          // Let a focused button do its own thing.
          if (isActivatable(event.target)) return
          event.preventDefault()
          current.toggle()
          break
        case 'ArrowRight':
          event.preventDefault()
          current.seekBy(event.shiftKey ? SEEK_STEP_LARGE_MS : SEEK_STEP_MS)
          break
        case 'ArrowLeft':
          event.preventDefault()
          current.seekBy(event.shiftKey ? -SEEK_STEP_LARGE_MS : -SEEK_STEP_MS)
          break
        case 'ArrowUp':
          event.preventDefault()
          current.setVolume(Math.min(1, current.volume() + VOLUME_STEP))
          break
        case 'ArrowDown':
          event.preventDefault()
          current.setVolume(Math.max(0, current.volume() - VOLUME_STEP))
          break
        default:
          break
      }

      // Letter keys are matched by physical position, so they survive layouts
      // where the letter itself moves (AZERTY, Dvorak).
      switch (event.code) {
        case 'KeyN':
          event.preventDefault()
          current.next()
          break
        case 'KeyP':
          event.preventDefault()
          current.previous()
          break
        case 'KeyM': {
          event.preventDefault()
          const level = current.volume()
          if (level > 0) {
            volumeBeforeMute = level
            current.setVolume(0)
          } else {
            current.setVolume(volumeBeforeMute || 0.8)
          }
          break
        }
        case 'Slash':
          event.preventDefault()
          current.focusSearch()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
