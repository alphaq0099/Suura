import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepeatMode, Track } from '@shared/types'
import { nextDecision, shuffleFrom, shuffled } from '@shared/queue'
import { api, messageOf } from '../api'

/** Replaying within this many seconds goes to the previous track instead. */
const RESTART_THRESHOLD_S = 3

export interface UsePlayerOptions {
  initialVolume: number
  /** From settings; changing it re-orders the live queue without interrupting playback. */
  repeat: RepeatMode
  shuffle: boolean
  onVolumeChange: (volume: number) => void
  /** Called with listened milliseconds; `completed` means the track reached its end. */
  onReport: (trackId: number, playedMs: number, completed: boolean) => void
}

export interface UsePlayerResult {
  current: Track | null
  /** The queue in playback order, which is what the queue panel shows. */
  queue: Track[]
  /** Position of `current` within `queue`, or -1 when nothing is playing. */
  index: number
  isPlaying: boolean
  isLoading: boolean
  positionMs: number
  durationMs: number
  volume: number
  error: string | null
  /** Replace the queue and start at `startIndex`. */
  playQueue: (tracks: Track[], startIndex: number) => void
  /**
   * Put a saved queue back without starting it.
   *
   * The track loads and seeks to `positionMs`, then stays paused: resuming means
   * "carry on from where I was", not "make noise the moment the window opens".
   */
  restore: (tracks: Track[], startIndex: number, positionMs: number) => void
  /** Append to the queue without disturbing playback. */
  enqueue: (tracks: Track[]) => void
  removeAt: (position: number) => void
  clearQueue: () => void
  jumpTo: (position: number) => void
  toggle: () => void
  next: () => void
  previous: () => void
  stop: () => void
  seek: (positionMs: number) => void
  setVolume: (volume: number) => void
}

/** Resolves when the element knows its duration (immediately if it already does). */
function onceLoadedMetadata(element: HTMLAudioElement): Promise<void> {
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      element.removeEventListener('loadedmetadata', done)
      resolve()
    }
    element.addEventListener('loadedmetadata', done)
  })
}

function describeMediaError(error: MediaError | null): string {
  if (!error) return 'Playback failed for an unknown reason.'
  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'Playback was stopped before it started.'
    case MediaError.MEDIA_ERR_NETWORK:
      return 'A network error interrupted playback.'
    case MediaError.MEDIA_ERR_DECODE:
      return 'This file could not be decoded. It may be corrupt.'
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'This format or codec is not supported.'
    default:
      return error.message || 'Playback failed.'
  }
}

/**
 * Wraps a single HTMLAudioElement and owns the queue.
 *
 * Playback state lives on the element rather than in React state, because the
 * element is the real source of truth for position and pause state; React state
 * here is a mirror for rendering only.
 *
 * The queue is held as an *ordered* array: shuffle reorders it and keeps the
 * original order aside, so turning shuffle back off restores what the user
 * actually queued. Repeat is applied when a track ends, not when the queue is
 * built, which is why `repeat` and `shuffle` are read through refs.
 *
 * Source URLs come from the main process (one per track, through the
 * `player-media://` scheme). The hook never constructs a file path itself, which
 * is what will let remote streaming slot in without changing this file.
 */
export function usePlayer(options: UsePlayerOptions): UsePlayerResult {
  const { initialVolume, repeat, shuffle, onVolumeChange, onReport } = options

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [entries, setEntries] = useState<Track[]>([])
  const [index, setIndex] = useState(-1)
  const [playRequestId, setPlayRequestId] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const [volume, setVolumeState] = useState(initialVolume)
  const [error, setError] = useState<string | null>(null)

  const loadTokenRef = useRef(0)
  const currentTrackRef = useRef<Track | null>(null)
  const onReportRef = useRef(onReport)
  const onVolumeChangeRef = useRef(onVolumeChange)
  const initialVolumeRef = useRef(initialVolume)

  // Mirrors of state that event handlers and callbacks need without
  // re-subscribing: `ended` fires long after the render that scheduled it.
  const entriesRef = useRef<Track[]>([])
  const indexRef = useRef(-1)
  const repeatRef = useRef<RepeatMode>(repeat)
  const shuffleRef = useRef(shuffle)
  /** The un-shuffled queue, so toggling shuffle off restores the real order. */
  const originRef = useRef<Track[] | null>(null)
  /**
   * Where a restored track should start, consumed once by the load effect.
   *
   * It is a ref rather than state because it belongs to the *load*, not to the
   * render: the effect that sets the source reads it and clears it, and no
   * render in between needs to see it.
   */
  const resumeRef = useRef<number | null>(null)

  useEffect(() => {
    onReportRef.current = onReport
  }, [onReport])

  useEffect(() => {
    onVolumeChangeRef.current = onVolumeChange
  }, [onVolumeChange])

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  useEffect(() => {
    indexRef.current = index
  }, [index])

  useEffect(() => {
    repeatRef.current = repeat
  }, [repeat])

  const audio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const element = new Audio()
      element.preload = 'auto'
      element.volume = initialVolumeRef.current
      audioRef.current = element
    }
    return audioRef.current
  }, [])

  const current = index >= 0 ? (entries[index] ?? null) : null

  // Reflect the stored volume once settings arrive from the main process.
  useEffect(() => {
    initialVolumeRef.current = initialVolume
    const element = audio()
    element.volume = initialVolume
    setVolumeState(initialVolume)
  }, [initialVolume, audio])

  // Load and play whenever the selected track changes, or the same track is
  // requested again (playRequestId).
  useEffect(() => {
    if (!current) return
    const element = audio()
    const token = ++loadTokenRef.current

    const previous = currentTrackRef.current
    if (previous && previous.id !== current.id) {
      onReportRef.current(previous.id, Math.round(element.currentTime * 1000), false)
    }
    currentTrackRef.current = current

    setError(null)
    setIsLoading(true)
    const resumeAt = resumeRef.current
    resumeRef.current = null
    setPositionMs(resumeAt ?? 0)
    setDurationMs(current.durationMs ?? 0)

    void (async () => {
      try {
        const source = await api.resolveSource({
          id: current.id,
          sourceKind: current.sourceKind,
          sourceId: current.sourceId,
          filePath: current.filePath
        })
        if (token !== loadTokenRef.current) return
        element.src = source.url
        element.load()
        if (resumeAt !== null) {
          // A position cannot be set before there is a duration to measure it
          // against, so the seek waits for metadata. `load()` was just called,
          // which makes that event certain to arrive.
          await onceLoadedMetadata(element)
          if (token !== loadTokenRef.current) return
          const end = Number.isFinite(element.duration) ? element.duration * 1000 : null
          const target = end === null ? resumeAt : Math.min(resumeAt, Math.max(end - 250, 0))
          element.currentTime = target / 1000
          setPositionMs(target)
          setDurationMs(end ?? current.durationMs ?? 0)
          return
        }
        await element.play()
      } catch (cause) {
        if (token !== loadTokenRef.current) return
        setError(messageOf(cause))
        setIsPlaying(false)
      } finally {
        if (token === loadTokenRef.current) setIsLoading(false)
      }
    })()
  }, [current, playRequestId, audio])

  // Element events -> React state.
  useEffect(() => {
    const element = audio()

    const handleTime = (): void => setPositionMs(element.currentTime * 1000)
    const handleDuration = (): void => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        setDurationMs(element.duration * 1000)
      }
    }
    const handlePlay = (): void => {
      setIsPlaying(true)
      setIsLoading(false)
    }
    const handlePause = (): void => setIsPlaying(false)
    const handleWaiting = (): void => setIsLoading(true)
    const handleCanPlay = (): void => setIsLoading(false)
    const handleError = (): void => {
      setError(describeMediaError(element.error))
      setIsPlaying(false)
      setIsLoading(false)
    }

    element.addEventListener('timeupdate', handleTime)
    element.addEventListener('loadedmetadata', handleDuration)
    element.addEventListener('durationchange', handleDuration)
    element.addEventListener('play', handlePlay)
    element.addEventListener('playing', handlePlay)
    element.addEventListener('pause', handlePause)
    element.addEventListener('waiting', handleWaiting)
    element.addEventListener('canplay', handleCanPlay)
    element.addEventListener('error', handleError)

    return () => {
      element.removeEventListener('timeupdate', handleTime)
      element.removeEventListener('loadedmetadata', handleDuration)
      element.removeEventListener('durationchange', handleDuration)
      element.removeEventListener('play', handlePlay)
      element.removeEventListener('playing', handlePlay)
      element.removeEventListener('pause', handlePause)
      element.removeEventListener('waiting', handleWaiting)
      element.removeEventListener('canplay', handleCanPlay)
      element.removeEventListener('error', handleError)
    }
  }, [audio])

  /**
   * Moves to the next entry, applying repeat.
   *
   * `completed` distinguishes a track that reached its end (where repeat-one
   * replays it) from the user pressing Next (where it should always move on).
   */
  const advance = useCallback((completed: boolean): void => {
    const decision = nextDecision(indexRef.current, entriesRef.current.length, repeatRef.current, completed)

    if (decision.kind === 'replay') {
      const element = audioRef.current
      if (element) {
        element.currentTime = 0
        void element.play().catch(() => setIsLoading(false))
      }
      return
    }

    if (decision.kind === 'play') {
      setIndex(decision.position)
      return
    }

    setIsPlaying(false)
  }, [])

  // Auto-advance at the end of a track.
  useEffect(() => {
    const element = audio()
    const handleEnded = (): void => {
      const finished = currentTrackRef.current
      if (finished) {
        const played = Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : 0
        onReportRef.current(finished.id, played, true)
      }
      advance(true)
    }

    element.addEventListener('ended', handleEnded)
    return () => element.removeEventListener('ended', handleEnded)
  }, [audio, advance])

  // Shuffle is a setting, so it can change while something is playing. Rebuild
  // the order around the current track instead of restarting playback.
  const previousShuffle = useRef(shuffle)
  useEffect(() => {
    shuffleRef.current = shuffle
    if (previousShuffle.current === shuffle) return
    previousShuffle.current = shuffle

    const queue = entriesRef.current
    if (queue.length === 0) return
    const playing = queue[indexRef.current] ?? null

    if (shuffle) {
      originRef.current = queue
      setEntries(playing ? shuffleFrom(queue, indexRef.current) : shuffled(queue))
      setIndex(playing ? 0 : -1)
      return
    }

    const restored = originRef.current ?? queue
    originRef.current = null
    const position = playing ? restored.findIndex((track) => track.id === playing.id) : -1
    setEntries(restored)
    setIndex(position >= 0 ? position : 0)
  }, [shuffle])

  const playQueue = useCallback((tracks: Track[], startIndex: number): void => {
    if (tracks.length === 0) return
    const safeIndex = startIndex >= 0 && startIndex < tracks.length ? startIndex : 0
    originRef.current = null

    if (shuffleRef.current) {
      setEntries(shuffleFrom(tracks, safeIndex))
      setIndex(0)
    } else {
      setEntries(tracks)
      setIndex(safeIndex)
    }
    // Forces a reload even when the same row is played twice.
    setPlayRequestId((value) => value + 1)
  }, [])

  const restore = useCallback((tracks: Track[], startIndex: number, positionMs: number): void => {
    if (tracks.length === 0) return
    const safeIndex = startIndex >= 0 && startIndex < tracks.length ? startIndex : 0
    originRef.current = null
    resumeRef.current = positionMs > 0 ? Math.round(positionMs) : null
    setEntries(tracks)
    setIndex(safeIndex)
    // The load effect keys off `current`, so an unchanged index would not reload;
    // the request id makes "restore over the same track" work too.
    setPlayRequestId((value) => value + 1)
  }, [])

  const enqueue = useCallback((tracks: Track[]): void => {
    if (tracks.length === 0) return
    const queue = entriesRef.current
    if (queue.length === 0) {
      setEntries(tracks)
      setIndex(0)
      setPlayRequestId((value) => value + 1)
      return
    }
    originRef.current = originRef.current ? [...originRef.current, ...tracks] : null
    setEntries([...queue, ...tracks])
  }, [])

  const removeAt = useCallback((position: number): void => {
    const queue = entriesRef.current
    if (position < 0 || position >= queue.length) return

    const playing = queue[indexRef.current] ?? null
    const remaining = queue.filter((_, at) => at !== position)
    originRef.current = originRef.current?.filter((_, at) => at !== position) ?? null

    if (remaining.length === 0) {
      audioRef.current?.pause()
      setEntries([])
      setIndex(-1)
      setIsPlaying(false)
      return
    }

    const playingPosition = playing ? remaining.findIndex((track) => track.id === playing.id) : -1
    setEntries(remaining)
    setIndex(playingPosition >= 0 ? playingPosition : Math.min(indexRef.current, remaining.length - 1))
  }, [])

  const clearQueue = useCallback((): void => {
    audioRef.current?.pause()
    originRef.current = null
    setEntries([])
    setIndex(-1)
    setIsPlaying(false)
  }, [])

  const jumpTo = useCallback((position: number): void => {
    const queue = entriesRef.current
    if (position < 0 || position >= queue.length) return
    if (position === indexRef.current) {
      setPlayRequestId((value) => value + 1)
      return
    }
    setIndex(position)
  }, [])

  const toggle = useCallback((): void => {
    const element = audio()
    if (!currentTrackRef.current) return
    if (element.paused) {
      void element.play().catch(() => setIsLoading(false))
    } else {
      element.pause()
    }
  }, [audio])

  const next = useCallback((): void => {
    advance(false)
  }, [advance])

  /** Media "stop": pause and rewind, unlike play/pause which keeps the position. */
  const stop = useCallback((): void => {
    const element = audio()
    element.pause()
    element.currentTime = 0
    setPositionMs(0)
  }, [audio])

  const previous = useCallback((): void => {
    const element = audio()
    if (element.currentTime > RESTART_THRESHOLD_S) {
      element.currentTime = 0
      // Same reason as `seek` and `stop`: the bar would otherwise sit at the old
      // position until the element next reports its time.
      setPositionMs(0)
      return
    }
    const position = indexRef.current
    if (position > 0) {
      setIndex(position - 1)
      return
    }
    if (repeatRef.current === 'all' && entriesRef.current.length > 0) {
      setIndex(entriesRef.current.length - 1)
    }
  }, [audio])

  const seek = useCallback(
    (targetMs: number): void => {
      if (!Number.isFinite(targetMs)) return
      const element = audio()
      const durationMs = Number.isFinite(element.duration) && element.duration > 0 ? element.duration * 1000 : null
      const target = Math.max(targetMs, 0)
      const clamped = durationMs === null ? target : Math.min(target, durationMs)
      element.currentTime = clamped / 1000
      // Published here rather than left to the element's next `timeupdate`. That
      // event fires a few times a second and still holds the position from before
      // the seek, so the scrubber snapped back to where it had been — and, worse,
      // the *next* seek was then measured against that stale number, which left
      // the bar one drag behind the audio for the rest of the track.
      setPositionMs(clamped)
    },
    [audio]
  )

  const setVolume = useCallback(
    (value: number): void => {
      const clamped = Math.min(Math.max(value, 0), 1)
      audio().volume = clamped
      setVolumeState(clamped)
      onVolumeChangeRef.current(clamped)
    },
    [audio]
  )

  const queue = useMemo(() => entries, [entries])

  return {
    current,
    queue,
    index,
    isPlaying,
    isLoading,
    positionMs,
    durationMs,
    volume,
    error,
    playQueue,
    restore,
    enqueue,
    removeAt,
    clearQueue,
    jumpTo,
    toggle,
    next,
    previous,
    stop,
    seek,
    setVolume
  }
}
