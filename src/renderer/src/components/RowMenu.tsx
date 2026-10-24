import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

export interface RowMenuItem {
  id: string
  label: string
  icon?: ReactNode
  danger?: boolean
  /**
   * When set, the first click changes the item to this label instead of running
   * the action. The second click confirms. Used for destructive actions that
   * should not happen from one stray click.
   */
  confirmLabel?: string
  onSelect: () => void | Promise<void>
}

export interface RowMenuProps {
  /** Page coordinates where the menu should open. */
  at: { x: number; y: number }
  /** Optional heading, usually the row's name. */
  title?: string
  items: RowMenuItem[]
  onClose: () => void
  /** Wider menus suit long playlist names; the default matches the track menu. */
  width?: number
  /**
   * Render into `document.body`. Menus opened from a transformed or filtered
   * ancestor (the now-playing panel) would otherwise be positioned against that
   * ancestor and clipped by it.
   */
  portal?: boolean
}

/**
 * A small popover used where a row has more than one less-common action.
 *
 * It is deliberately generic: the playlist index uses it for Rename/Delete and
 * the playlist tracks use it for Details/Remove. The interaction is the same as
 * the library's context menu, including Escape and click-outside to close.
 */
export function RowMenu({ at, title, items, onClose, width = 220, portal = false }: RowMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null
      if (node && containerRef.current?.contains(node)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  // A menu opened from the keyboard must be usable from the keyboard: the row
  // list keeps its own focus, so move it to the first action on mount.
  useEffect(() => {
    containerRef.current?.querySelector<HTMLButtonElement>('.context-item')?.focus()
  }, [])

  const height = 44 + Math.max(1, items.length) * 36
  const style = {
    left: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)),
    width
  }

  const content = (
    <div
      ref={containerRef}
      className="context-menu row-menu"
      style={style}
      role="menu"
      aria-label={title ? `Actions for ${title}` : 'Row actions'}
    >
      {title ? (
        <div className="context-head" title={title}>
          {title}
        </div>
      ) : null}
      {items.map((item) => {
        const awaitingConfirmation = item.confirmLabel !== undefined && confirming === item.id
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={['context-item', item.danger ? 'danger' : '', awaitingConfirmation ? 'confirming' : '']
              .filter(Boolean)
              .join(' ')}
            onClick={() => {
              if (item.confirmLabel !== undefined && !awaitingConfirmation) {
                setConfirming(item.id)
                return
              }
              void item.onSelect()
              onClose()
            }}
          >
            {item.icon}
            <span>{awaitingConfirmation ? item.confirmLabel : item.label}</span>
          </button>
        )
      })}
    </div>
  )

  return portal ? createPortal(content, document.body) : content
}
