import { useEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  RefObject
} from 'react'
import { ClipboardIcon, CloseIcon, CopyIcon } from './Icons'

const WIDTH = 190
const HEIGHT = 130

export interface FieldMenuPosition {
  x: number
  y: number
}

export interface FieldContextMenuProps {
  at: FieldMenuPosition
  hasValue: boolean
  onPaste: () => void
  onCopy: () => void
  onClear: () => void
  onClose: () => void
}

/**
 * The menu for a text field.
 *
 * Electron gives a bare input no menu at all, and the app's other menus are
 * custom, so this one offers the two things a search or link field is for:
 * putting text in and taking it back out. Paste is the reason it exists; Copy and
 * Clear keep the right-click from feeling like a one-trick shortcut.
 */
export function FieldContextMenu(props: FieldContextMenuProps) {
  const { at, hasValue, onPaste, onCopy, onClear, onClose } = props
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null
      if (node && containerRef.current?.contains(node)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const style = {
    left: Math.max(8, Math.min(at.x, window.innerWidth - WIDTH - 8)),
    top: Math.max(8, Math.min(at.y, window.innerHeight - HEIGHT - 8))
  }

  return (
    <div
      ref={containerRef}
      className="context-menu field-menu"
      style={style}
      role="menu"
      aria-label="Field actions"
    >
      <button
        type="button"
        role="menuitem"
        className="context-item"
        onClick={() => {
          onPaste()
          onClose()
        }}
      >
        <ClipboardIcon size={14} />
        <span>Paste</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-item"
        disabled={!hasValue}
        onClick={() => {
          onCopy()
          onClose()
        }}
      >
        <CopyIcon size={14} />
        <span>Copy</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-item"
        disabled={!hasValue}
        onClick={() => {
          onClear()
          onClose()
        }}
      >
        <CloseIcon size={14} />
        <span>Clear</span>
      </button>
    </div>
  )
}

export interface FieldMenuController {
  at: FieldMenuPosition | null
  open: (event: ReactMouseEvent<Element>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
  close: () => void
}

/**
 * Tracks where a field menu should open, including the keyboard route
 * (ContextMenu or Shift+F10). The field itself stays in charge of what Paste,
 * Copy and Clear mean, because the link field and the search fields differ.
 */
export function useFieldContextMenu(
  inputRef: RefObject<HTMLInputElement | null>
): FieldMenuController {
  const [at, setAt] = useState<FieldMenuPosition | null>(null)

  const openFromKeyboard = (): void => {
    const rect = inputRef.current?.getBoundingClientRect()
    if (!rect) return
    setAt({ x: rect.left + 10, y: rect.bottom + 4 })
  }

  const open = (event: ReactMouseEvent<Element>): void => {
    event.preventDefault()
    setAt({ x: event.clientX, y: event.clientY })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      openFromKeyboard()
    }
  }

  return { at, open, onKeyDown, close: () => setAt(null) }
}
