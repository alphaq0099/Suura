import { useEffect, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function visibleFocusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute('disabled') &&
      element.getClientRects().length > 0
  )
}

/**
 * Keeps a modal usable with the keyboard alone.
 *
 * Tab and Shift+Tab wrap inside the dialog instead of walking into the window
 * behind it, and the control that opened the dialog gets focus back when the
 * dialog closes. Both matter most for a tag editor opened from a row menu: the
 * menu is gone by the time the editor closes, so the browser would otherwise
 * drop focus on <body> and the user would have to start tabbing from the top.
 *
 * Each dialog still decides where focus lands first; this only supplies the
 * boundary and the way home.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = visibleFocusables(node)
      if (items.length === 0) {
        event.preventDefault()
        node.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (event.shiftKey) {
        if (active === first || !node.contains(active)) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !node.contains(active)) {
        event.preventDefault()
        first.focus()
      }
    }

    node.addEventListener('keydown', onKeyDown)
    return () => {
      node.removeEventListener('keydown', onKeyDown)
      if (opener && opener.isConnected && !node.contains(opener)) opener.focus()
    }
  }, [ref])
}
