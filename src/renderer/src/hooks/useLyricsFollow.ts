import { useCallback, useEffect, useRef, useState } from 'react'

/** How long a manual scroll keeps the lyrics from pulling themselves back. */
const FOLLOW_PAUSE_MS = 5000

/**
 * Keeps the line being sung in the middle of its list.
 *
 * The list is scrolled by hand with `offsetTop` rather than `scrollIntoView`,
 * because the latter also moves whatever scrolls behind the panel. Reading back
 * a verse is a normal thing to want, so a wheel over the list pauses the follow
 * for a few seconds instead of fighting the reader; `resume` hands it back.
 *
 * The same hook drives the side panel and the full-window stage: both are just
 * a list of lyric lines, and only one of them is on screen at a time.
 */
export function useLyricsFollow(active: number, resetKey: string | number | null) {
  const listRef = useRef<HTMLOListElement | null>(null)
  const activeRef = useRef<HTMLLIElement | null>(null)
  const [following, setFollowing] = useState(true)
  const resumeRef = useRef<number | null>(null)
  const reducedMotionRef = useRef(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => {
      reducedMotionRef.current = query.matches
    }
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  // A new song starts following again, even if the old one was being read back.
  useEffect(() => {
    setFollowing(true)
    if (resumeRef.current !== null) {
      window.clearTimeout(resumeRef.current)
      resumeRef.current = null
    }
  }, [resetKey])

  const centerActive = useCallback((): void => {
    const list = listRef.current
    const row = activeRef.current
    if (!list || !row) return
    const top = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2
    list.scrollTo({ top: Math.max(0, top), behavior: reducedMotionRef.current ? 'auto' : 'smooth' })
  }, [])

  useEffect(() => {
    if (active < 0 || !following) return
    centerActive()
  }, [active, following, centerActive])

  const pauseFollow = useCallback((): void => {
    setFollowing(false)
    if (resumeRef.current !== null) window.clearTimeout(resumeRef.current)
    resumeRef.current = window.setTimeout(() => {
      resumeRef.current = null
      setFollowing(true)
    }, FOLLOW_PAUSE_MS)
  }, [])

  const resume = useCallback((): void => {
    if (resumeRef.current !== null) {
      window.clearTimeout(resumeRef.current)
      resumeRef.current = null
    }
    setFollowing(true)
  }, [])

  useEffect(
    () => () => {
      if (resumeRef.current !== null) window.clearTimeout(resumeRef.current)
    },
    []
  )

  return { listRef, activeRef, following, pauseFollow, resume }
}
