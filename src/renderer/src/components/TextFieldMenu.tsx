import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { ClipboardIcon, CloseIcon, CopyIcon, CutIcon, SelectAllIcon } from './Icons'

/**
 * The right-click menu every text field gets.
 *
 * Electron draws no menu for an input on its own, and the app's other menus are
 * custom, so a field with no menu of its own felt broken: selecting a word and
 * reaching for Cut did nothing. One listener at the document level covers every
 * field in the app, including the ones inside dialogs, instead of each form
 * wiring the same five actions again.
 *
 * Fields that already draw their own menu (the search box, the link box) keep
 * it: their wrapper carries `data-field-menu`, and this host steps aside for
 * anything inside one. Their menus do app-level things (paste-and-search) that
 * are not the same as editing text.
 */

interface MenuState {
  element: HTMLInputElement | HTMLTextAreaElement
  x: number
  y: number
  hasSelection: boolean
  hasValue: boolean
}

const MENU_WIDTH = 190
const MENU_HEIGHT = 210

/** The field types where a text selection means something. */
const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password'])

function isTextField(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  if (target instanceof HTMLTextAreaElement) return !target.disabled
  if (!(target instanceof HTMLInputElement)) return false
  return TEXT_TYPES.has(target.type) && !target.disabled
}

/** True when the field sits inside a box that draws a menu of its own. */
function ownsItsMenu(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('[data-field-menu]'))
}

/**
 * The selection, without throwing on the input types Chromium refuses to
 * report it for. A field that cannot answer is treated as having no selection,
 * which leaves Copy copying the whole value and Paste replacing the field.
 */
function selectionOf(element: HTMLInputElement | HTMLTextAreaElement): { start: number; end: number } {
  try {
    const start = element.selectionStart ?? element.value.length
    const end = element.selectionEnd ?? start
    return { start, end }
  } catch {
    return { start: element.value.length, end: element.value.length }
  }
}

function selectedText(element: HTMLInputElement | HTMLTextAreaElement): string {
  const { start, end } = selectionOf(element)
  return element.value.slice(start, end)
}

/**
 * Replaces the selection with `text` and leaves the caret after it.
 *
 * `insertText` is the browser's own editing path, so a controlled React field
 * sees the same `input` event a keystroke produces and its state stays in step.
 * The fallback exists for the rare refusal (an input type the command will not
 * touch): it goes through the native value setter, because assigning `.value`
 * directly is what React's change tracker is built to ignore.
 */
function replaceSelection(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string
): void {
  const { start, end } = selectionOf(element)
  element.focus()
  try {
    element.setSelectionRange(start, end)
  } catch {
    // Some input types do not support a range; the command below still works.
  }
  if (document.execCommand('insertText', false, text)) return

  const next = element.value.slice(0, start) + text + element.value.slice(end)
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, next)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  const caret = start + text.length
  try {
    element.setSelectionRange(caret, caret)
  } catch {
    // Nothing to restore.
  }
}

async function copyOut(element: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  const text = selectedText(element) || element.value
  if (text.length === 0) return
  try {
    await api.writeClipboardText(text)
  } catch {
    // A denied clipboard should not close the editor with an error banner.
  }
}

/**
 * Copies the selection and removes it. A cut that only removed text would look
 * like it worked and then paste nothing, so the clipboard comes first.
 */
async function cutOut(element: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  const text = selectedText(element)
  if (text.length === 0) return
  try {
    await api.writeClipboardText(text)
  } catch {
    // Still remove it: the field should not ignore the click because the
    // clipboard is busy.
  }
  replaceSelection(element, '')
}

async function pasteIn(element: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
  let text = ''
  try {
    text = await api.readClipboardText()
  } catch {
    return
  }
  if (text.length === 0) return
  replaceSelection(element, text)
}

function editableOf(element: HTMLInputElement | HTMLTextAreaElement): boolean {
  return !element.disabled && !element.readOnly
}

/**
 * Opens the menu for the field under the pointer. Mounted once, at the root.
 */
export function TextFieldMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const openFor = (element: HTMLInputElement | HTMLTextAreaElement, x: number, y: number): void => {
      const { start, end } = selectionOf(element)
      setMenu({
        element,
        x,
        y,
        hasSelection: end > start,
        hasValue: element.value.length > 0
      })
    }

    const onContextMenu = (event: MouseEvent): void => {
      if (event.defaultPrevented) return
      if (ownsItsMenu(event.target)) return
      if (!isTextField(event.target)) return
      event.preventDefault()
      openFor(event.target, event.clientX, event.clientY)
    }

    // Bubble phase: the fields that draw their own menu are marked and skipped.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      if (ownsItsMenu(event.target)) return
      if (!isTextField(event.target)) return
      event.preventDefault()
      const rect = event.target.getBoundingClientRect()
      openFor(event.target, rect.left + 10, rect.bottom + 4)
    }

    // A press anywhere but the menu itself closes it.
    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null
      if (node && menuRef.current?.contains(node)) return
      setMenu(null)
    }

    const onDismiss = (): void => setMenu(null)

    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('blur', onDismiss)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('blur', onDismiss)
    }
  }, [])

  useEffect(() => {
    if (!menu) return
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setMenu(null)
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [menu])

  if (!menu) return null

  const { element } = menu
  const editable = editableOf(element)
  const style = {
    left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8)),
    top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8))
  }

  const run = (action: () => void | Promise<void>): void => {
    setMenu(null)
    void action()
  }

  return (
    <div
      ref={menuRef}
      className="context-menu field-menu text-menu"
      style={style}
      role="menu"
      aria-label="Text actions"
    >
      <button
        type="button"
        role="menuitem"
        className="context-item"
        disabled={!editable || !menu.hasSelection}
        onClick={() => run(() => cutOut(element))}
      >
        <CutIcon size={14} />
        <span>Cut</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-item"
        disabled={!menu.hasValue}
        onClick={() => run(() => copyOut(element))}
      >
        <CopyIcon size={14} />
        <span>Copy</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-item"
        disabled={!editable}
        onClick={() => run(() => pasteIn(element))}
      >
        <ClipboardIcon size={14} />
        <span>Paste</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-item"
        disabled={!menu.hasValue}
        onClick={() => run(() => element.select())}
      >
        <SelectAllIcon size={14} />
        <span>Select all</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-item"
        disabled={!editable || !menu.hasValue}
        onClick={() =>
          run(() => {
            element.select()
            replaceSelection(element, '')
          })
        }
      >
        <CloseIcon size={14} />
        <span>Clear</span>
      </button>
    </div>
  )
}
