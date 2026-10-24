import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioSettings, RepeatMode } from '@shared/types'
import { nextDecision, shuffleFrom, shuffled, type QueueTrack } from '@shared/queue'
import { recoveryDelayMs, shouldRecoverPlayback } from '@shared/playback-recovery'
import { api, messageOf } from '../api'
import { PlaybackAudioChain } from '../audio/playback-chain'

/** Replaying within this many seconds goes to the previous track instead. */
const RESTART_THRESHOLD_S = 3

/**
 * How long a stream plays before the next track's resolve starts in the background.
 *
 * Late enough that skimming a queue does not spawn a sidecar per skipped track,
 * early enough that a listener who settles in gets the whole warm-up for free.
 */
const PREFETCH_DELAY_MS = 4000

/**
 * No progress for this long after playback started is treated as a stall.
 *
 * A dropped connection does not always fire `error`: the element can sit in
 * `waiting` forever. The timeout is generous enough to cover a slow buffer and
 * short enough that the listener does not have to notice and press play.
 */
const STALL_TIMEOUT_MS = 15_000

/**
 * A resolve that took this long before failing is not the kind of transient
 * blip the reconnect loop is for.
 *
 * yt-dlp has its own deadline. When it expires, retrying immediately spends the
 * same deadline again and the listener waits twice as long for the same answer.
 * The error is shown instead; pressing play is the retry.
 */
const SLOW_RESOLVE_MS = 10_000

/** Total wall-clock budget for one automatic reconnect, independent of attempts. */
const RECOVERY_BUDGET_MS = 30_000

export interface UsePlayerOptions {
  initialVolume: number
  /** Equaliser and normalization. They apply live, without reloading a track. */
  audioSettings: AudioSettings
  /** From settings; changing it re-orders the live queue without interrupting playback. */
  repeat: RepeatMode
  shuffle: boolean
  /** Resolve the next YouTube entry while this one plays. */
  prefetchNext: boolean
  onVolumeChange: (volume: number) => void
  /** Called with listened milliseconds; `completed` means the track reached its end. */
  onReport: (trackId: number, playedMs: number, completed: boolean) => void
}

export interface UsePlayerResult {
  current: QueueTrack | null
  /** The queue in playback order, which is what the queue panel shows. */
  queue: QueueTrack[]
  /** Position of `current` within `queue`, or -1 when nothing is playing. */
  index: number
  isPlaying: boolean
  isLoading: boolean
  /** True while the interrupted stream is being retried automatically. */
  reconnecting: boolean
  positionMs: number
  durationMs: number
  volume: number
  error: string | null
  /** Replace the queue and start at `startIndex`. */
  playQueue: (tracks: QueueTrack[], startIndex: number) => void
  /**
   * Put a saved queue back without starting it.
   *
   * The track loads and seeks to `positionMs`, then stays paused unless
   * `autoPlay` is true: resuming means "carry on from where I was", not "make
   * noise the moment the window opens".
   */
  restore: (tracks: QueueTrack[], startIndex: number, positionMs: number, autoPlay?: boolean) => void
  /** Append to the queue without disturbing playback. */
  enqueue: (tracks: QueueTrack[]) => void
  removeAt: (position: number) => void
  /** Reorder one visible row. Works while shuffle is on, too. */
  move: (from: number, to: number) => void
  /** Drop every row before the current one, keeping the current track at the front. */
  removePlayed: () => void
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
  return new Promise((resolve, reject) => {
    const done = (): void => {
      cleanup()
      resolve()
    }
    // Waiting only for metadata leaves this promise pending forever when the
    // stream fails before its headers arrive -- which is exactly what a 503 from
    // the reconnecting proxy looks like. Reject so the load path can recover.
    const failed = (): void => {
      cleanup()
      reject(new Error('The stream could not be loaded.'))
    }
    const cleanup = (): void => {
      element.removeEventListener('loadedmetadata', done)
      element.removeEventListener('error', failed)
      element.removeEventListener('abort', failed)
    }
    element.addEventListener('loadedmetadata', done)
    element.addEventListener('error', failed)
    element.addEventListener('abort', failed)
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
  const { initialVolume, audioSettings, repeat, shuffle, prefetchNext, onVolumeChange, onReport } =
    options

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioChainRef = useRef<PlaybackAudioChain | null>(null)
  const audioSettingsRef = useRef(audioSettings)
  const [entries, setEntries] = useState<QueueTrack[]>([])
  const [index, setIndex] = useState(-1)
  const [playRequestId, setPlayRequestId] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const [volume, setVolumeState] = useState(initialVolume)
  const [error, setError] = useState<string | null>(null)

  const loadTokenRef = useRef(0)
  const currentTrackRef = useRef<QueueTrack | null>(null)
  const onReportRef = useRef(onReport)
  const onVolumeChangeRef = useRef(onVolumeChange)
  const initialVolumeRef = useRef(initialVolume)

  // Mirrors of state that event handlers and callbacks need without
  // re-subscribing: `ended` fires long after the render that scheduled it.
  const entriesRef = useRef<QueueTrack[]>([])
  const indexRef = useRef(-1)
  const repeatRef = useRef<RepeatMode>(repeat)
  const shuffleRef = useRef(shuffle)
  /** The un-shuffled queue, so toggling shuffle off restores the real order. */
  const originRef = useRef<QueueTrack[] | null>(null)
  /**
   * Where a restored track should start, consumed once by the load effect.
   *
   * It is a ref rather than state because it belongs to the *load*, not to the
   * render: the effect that sets the source reads it and clears it, and no
   * render in between needs to see it.
   */
  const resumeRef = useRef<number | null>(null)
  /** Whether the next load is a restore that should start playing. */
  const resumePlayRef = useRef(false)
  /** Video ids already warmed this session, so a re-render never re-asks. */
  const prefetchedRef = useRef(new Set<string>())

  /**
   * What the listener last asked for, which is not the same as what the element
   * is doing: a failed request must not cancel the intent to play.
   */
  const wantsPlayRef = useRef(false)
  const recoveryAttemptRef = useRef(0)
  const recoveryStartedAtRef = useRef(0)
  const recoveryTimerRef = useRef<number | null>(null)
  const stallTimerRef = useRef<number | null>(null)
  const reconnectingRef = useRef(false)
  /** Last position known to be playing, used when the element loses its own time. */
  const lastPositionRef = useRef(0)
  /** The last real failure, kept so the final message is not a generic one. */
  const lastFailureRef = useRef<string | null>(null)
  const scheduleRecoveryRef = useRef<(immediate?: boolean) => void>(() => undefined)

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
      // Created with the element, because a MediaElementAudioSourceNode can be
      // attached exactly once. The chain falls back to direct element output if
      // Web Audio is unavailable, and the element keeps its own volume until
      // `active` is true.
      audioChainRef.current = new PlaybackAudioChain(
        element,
        initialVolumeRef.current,
        audioSettingsRef.current
      )
    }
    return audioRef.current
  }, [])

  const current = index >= 0 ? (entries[index] ?? null) : null

  const clearRecoveryTimer = useCallback((): void => {
    if (recoveryTimerRef.current !== null) {
      window.clearTimeout(recoveryTimerRef.current)
      recoveryTimerRef.current = null
    }
  }, [])

  const clearStallTimer = useCallback((): void => {
    if (stallTimerRef.current !== null) {
      window.clearTimeout(stallTimerRef.current)
      stallTimerRef.current = null
    }
  }, [])

  const setReconnectState = useCallback((value: boolean): void => {
    reconnectingRef.current = value
    setReconnecting(value)
  }, [])

  /** Forgets the retry budget and any pending attempt. */
  const resetRecovery = useCallback((): void => {
    clearRecoveryTimer()
    clearStallTimer()
    recoveryAttemptRef.current = 0
    recoveryStartedAtRef.current = 0
    if (reconnectingRef.current) setReconnectState(false)
  }, [clearRecoveryTimer, clearStallTimer, setReconnectState])

  const giveUpRecovery = useCallback((): void => {
    setReconnectState(false)
    setIsLoading(false)
    setError(lastFailureRef.current ?? 'Playback could not be reconnected. Check your connection, then press play.')
  }, [setReconnectState])

  /** Data is flowing again: the attempt counter starts over. */
  const settleRecovery = useCallback((): void => {
    resetRecovery()
    lastFailureRef.current = null
    setError(null)
  }, [resetRecovery])

  /**
   * Schedules the next reconnect, reloading the same token from the last position.
   *
   * Re-running the load path (rather than only calling `play()` on a dead
   * element) is what makes recovery work: `load()` throws away the failed
   * request, the main process gets another chance to refresh the URL, and the
   * saved position is restored once metadata arrives.
   */
  const scheduleRecovery = useCallback(
    (immediate = false): void => {
      if (recoveryTimerRef.current !== null) return
      if (!wantsPlayRef.current || !currentTrackRef.current) return

      if (recoveryAttemptRef.current === 0) recoveryStartedAtRef.current = Date.now()
      const overBudget =
        recoveryStartedAtRef.current > 0 && Date.now() - recoveryStartedAtRef.current > RECOVERY_BUDGET_MS
      const delay = immediate ? 0 : recoveryDelayMs(recoveryAttemptRef.current)
      if (delay === null || overBudget) {
        giveUpRecovery()
        return
      }

      recoveryAttemptRef.current += 1
      setIsLoading(true)
      setReconnectState(true)
      setError(null)

      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null
        if (!wantsPlayRef.current || !currentTrackRef.current) {
          setReconnectState(false)
          setIsLoading(false)
          return
        }

        const element = audioRef.current
        const at =
          element && Number.isFinite(element.currentTime) && element.currentTime > 0
            ? element.currentTime * 1000
            : lastPositionRef.current
        // A second back: the audio already buffered before the failure stays
        // usable, and resuming exactly on the boundary asks for the one range
        // the CDN just failed to deliver.
        resumeRef.current = Math.max(0, Math.round(at) - 1_000)
        resumePlayRef.current = true
        setPlayRequestId((value) => value + 1)
      }, delay)
    },
    [giveUpRecovery, setReconnectState]
  )

  useEffect(() => {
    scheduleRecoveryRef.current = scheduleRecovery
  }, [scheduleRecovery])

  /** Regaining connectivity is the best moment to try, without waiting out the backoff. */
  const retryNow = useCallback((): void => {
    if (!wantsPlayRef.current || !currentTrackRef.current) return
    clearRecoveryTimer()
    recoveryAttemptRef.current = 0
    scheduleRecovery(true)
  }, [clearRecoveryTimer, scheduleRecovery])

  /**
   * Watches a stream that went quiet without firing `error`.
   *
   * Only mid-playback: `currentTime > 0` means this is a stall, not the normal
   * buffering wait at the start of a track.
   */
  const armStallTimer = useCallback((): void => {
    if (stallTimerRef.current !== null) return
    stallTimerRef.current = window.setTimeout(() => {
      stallTimerRef.current = null
      const element = audioRef.current
      if (!wantsPlayRef.current || !element || element.error) return
      if (element.paused || element.currentTime <= 0) return
      if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return
      scheduleRecoveryRef.current()
    }, STALL_TIMEOUT_MS)
  }, [])

  // Episode of connectivity returning. The backoff can be up to eight seconds,
  // and the listener should not have to wait it out after the network is back.
  useEffect(() => {
    const handleOnline = (): void => {
      if (!wantsPlayRef.current || !currentTrackRef.current) return
      if (!reconnectingRef.current && !audioRef.current?.error) return
      retryNow()
    }
    window.addEventListener('online', handleOnline)
    return () => window.removeEventListener('online', handleOnline)
  }, [retryNow])


  // Apply equaliser changes live. `audio()` also creates the chain on first run,
  // so this effect can safely run before the first track loads.
  useEffect(() => {
    audioSettingsRef.current = audioSettings
    audio()
    audioChainRef.current?.setSettings(audioSettings)
  }, [audioSettings, audio])

  // Reflect the stored volume once settings arrive from the main process.
  useEffect(() => {
    initialVolumeRef.current = initialVolume
    const element = audio()
    if (!audioChainRef.current?.setVolume(initialVolume)) element.volume = initialVolume
    setVolumeState(initialVolume)
  }, [initialVolume, audio])

  // The chain is intentionally not disposed by an effect cleanup. React's
  // development StrictMode mounts, cleans up and remounts effects; a cleanup
  // here would close the context while the already-linked media element stayed
  // alive, and a second MediaElementAudioSourceNode can never be created. The
  // hook lives for the whole window, so the context is released with the page.

  // Load and play whenever the selected track changes, or the same track is
  // requested again (playRequestId).
  useEffect(() => {
    if (!current) return
    const element = audio()
    const token = ++loadTokenRef.current

    const previous = currentTrackRef.current
    if (previous && previous.id !== current.id) {
      onReportRef.current(previous.id, Math.round(element.currentTime * 1000), false)
      // Cut the outgoing track off now. A stream resolve takes seconds, and the
      // old source stays attached until it answers: without this the previous
      // song keeps playing over the spinner, so Next looks like it did nothing.
      element.pause()
      // A new track starts with a new retry budget. Doing this only on an id
      // change matters: a recovery reloads the same track and must keep count.
      resetRecovery()
      lastFailureRef.current = null
      lastPositionRef.current = 0
    }
    currentTrackRef.current = current

    setError(null)
    setIsLoading(true)
    const resumeAt = resumeRef.current
    resumeRef.current = null
    const shouldPlay = resumePlayRef.current
    resumePlayRef.current = false
    // A normal load always plays; a restore only if it asked to. Recording the
    // intent here means a later network failure knows whether to recover at all.
    wantsPlayRef.current = resumeAt === null ? true : shouldPlay
    setPositionMs(resumeAt ?? 0)
    setDurationMs(current.durationMs ?? 0)
    // Do not let the previous track's ReplayGain apply to a new, unmeasured one
    // while its source is being resolved.
    audioChainRef.current?.setTrackGain(null, null)

    const loadStartedAt = Date.now()
    void (async () => {
      try {
        const source = await api.resolveSource({
          id: current.id,
          sourceKind: current.sourceKind,
          sourceId: current.sourceId,
          filePath: current.filePath
        })
        if (token !== loadTokenRef.current) return
        audioChainRef.current?.setTrackGain(
          source.replayGainDb ?? null,
          source.replayGainPeak ?? null
        )
        element.src = source.url
        element.load()
        audioChainRef.current?.resume()
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
          if (shouldPlay) await element.play()
          return
        }
        await element.play()
      } catch (cause) {
        if (token !== loadTokenRef.current) return
        lastFailureRef.current = messageOf(cause)
        const blocked = cause instanceof DOMException && cause.name === 'NotAllowedError'
        // A resolve is also part of the stream: if the network is down it fails
        // before the element ever gets a source, so it needs the same recovery.
        // A deadline that already ran out is different: retrying it would spend
        // the whole timeout again, which is the reason one Play could hang for
        // minutes. Show that error and let the listener decide.
        const slowResolve = Date.now() - loadStartedAt >= SLOW_RESOLVE_MS
        if (!blocked && !slowResolve && wantsPlayRef.current && current.sourceKind === 'youtube') {
          scheduleRecoveryRef.current()
          return
        }
        setError(messageOf(cause))
        setIsPlaying(false)
        setReconnectState(false)
      } finally {
        // While a reconnect is pending the spinner stays on; the retry timer,
        // not this attempt, decides when the wait is over.
        if (token === loadTokenRef.current && !reconnectingRef.current) setIsLoading(false)
      }
    })()
  }, [current, playRequestId, audio, resetRecovery, setReconnectState])

  // Element events -> React state.
  useEffect(() => {
    const element = audio()

    const handleTime = (): void => {
      const at = element.currentTime * 1000
      lastPositionRef.current = at
      setPositionMs(at)
      clearStallTimer()
      // `timeupdate` is the "data is flowing" signal, but a queued event can
      // still arrive after an error. Never let that cancel a pending retry.
      if (reconnectingRef.current && !element.error && !element.paused) settleRecovery()
    }
    const handleDuration = (): void => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        setDurationMs(element.duration * 1000)
      }
    }
    const handlePlay = (): void => {
      // Autoplay policy can leave a newly created context suspended. Resuming
      // on the element's own play event is the most reliable gesture we get.
      audioChainRef.current?.resume()
      setIsPlaying(true)
      setIsLoading(false)
    }
    const handlePlaying = (): void => {
      audioChainRef.current?.resume()
      setIsPlaying(true)
      setIsLoading(false)
      // `playing` means bytes are actually moving, unlike `play`.
      settleRecovery()
    }
    const handlePause = (): void => {
      setIsPlaying(false)
      clearStallTimer()
    }
    const handleWaiting = (): void => {
      setIsLoading(true)
      if (wantsPlayRef.current && element.currentTime > 0) armStallTimer()
    }
    const handleCanPlay = (): void => {
      setIsLoading(false)
      clearStallTimer()
    }
    const handleError = (): void => {
      const mediaError = element.error
      const at = Number.isFinite(element.currentTime) ? element.currentTime * 1000 : 0
      if (at > 0) lastPositionRef.current = at
      clearStallTimer()
      const failure = describeMediaError(mediaError)

      // A network loss is not the end of the track: keep the intent, show the
      // reconnect state and try again from where it stopped.
      if (
        shouldRecoverPlayback(
          mediaError?.code ?? null,
          currentTrackRef.current?.sourceKind ?? null,
          wantsPlayRef.current
        )
      ) {
        setIsPlaying(false)
        setIsLoading(true)
        scheduleRecoveryRef.current()
        return
      }

      setError(failure)
      setIsPlaying(false)
      setIsLoading(false)
      setReconnectState(false)
    }

    element.addEventListener('timeupdate', handleTime)
    element.addEventListener('loadedmetadata', handleDuration)
    element.addEventListener('durationchange', handleDuration)
    element.addEventListener('play', handlePlay)
    element.addEventListener('playing', handlePlaying)
    element.addEventListener('pause', handlePause)
    element.addEventListener('waiting', handleWaiting)
    element.addEventListener('canplay', handleCanPlay)
    element.addEventListener('error', handleError)

    return () => {
      element.removeEventListener('timeupdate', handleTime)
      element.removeEventListener('loadedmetadata', handleDuration)
      element.removeEventListener('durationchange', handleDuration)
      element.removeEventListener('play', handlePlay)
      element.removeEventListener('playing', handlePlaying)
      element.removeEventListener('pause', handlePause)
      element.removeEventListener('waiting', handleWaiting)
      element.removeEventListener('canplay', handleCanPlay)
      element.removeEventListener('error', handleError)
    }
  }, [audio, armStallTimer, clearStallTimer, setReconnectState, settleRecovery])

  /**
   * Moves to the next entry, applying repeat.
   *
   * `completed` distinguishes a track that reached its end (where repeat-one
   * replays it) from the user pressing Next (where it should always move on).
   */
  const advance = useCallback(
    (completed: boolean): void => {
      const decision = nextDecision(indexRef.current, entriesRef.current.length, repeatRef.current, completed)

      if (decision.kind === 'replay') {
        const element = audioRef.current
        if (element) {
          wantsPlayRef.current = true
          resetRecovery()
          element.currentTime = 0
          audioChainRef.current?.resume()
          void element.play().catch(() => setIsLoading(false))
        }
        return
      }

      if (decision.kind === 'play') {
        setIndex(decision.position)
        return
      }

      wantsPlayRef.current = false
      resetRecovery()
      setIsPlaying(false)
    },
    [resetRecovery]
  )

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

  // Resolve the next stream while this one plays.
  //
  // The sidecar run is 7-10 s and it is the entire wait between two queued tracks;
  // the audio itself, once the URL exists, starts in well under a second. Doing the
  // resolve early moves that cost into a song the user is already listening to, so
  // Next is a buffer, not a download. It is deliberately late (a few seconds in)
  // and dropped on every track change: a user who is skipping through a playlist is
  // not going to reach any of these tracks, and each warm-up costs a subprocess.
  // The current track may be a local file with a stream behind it, so the guard is
  // on the *next* entry rather than on what is playing now.
  useEffect(() => {
    if (!current || !isPlaying || !prefetchNext) return
    const timer = setTimeout(() => {
      const decision = nextDecision(indexRef.current, entriesRef.current.length, repeatRef.current, false)
      if (decision.kind !== 'play') return
      const upcoming = entriesRef.current[decision.position]
      if (!upcoming || upcoming.sourceKind !== 'youtube' || !upcoming.sourceId) return
      const videoId = upcoming.sourceId
      if (prefetchedRef.current.has(videoId)) return
      // Recorded before the call: a failure is not worth retrying on the next
      // render, and asking twice for the same video would spawn two sidecars.
      prefetchedRef.current.add(videoId)
      void api
        .prefetchSource({
          id: upcoming.id,
          sourceKind: upcoming.sourceKind,
          sourceId: videoId,
          filePath: upcoming.filePath
        })
        .catch(() => {
          // A failed warm-up must not count as warm. After a network outage the
          // next track would otherwise resolve cold in the middle of playback.
          prefetchedRef.current.delete(videoId)
        })
    }, PREFETCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [current, isPlaying, prefetchNext])

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

  const playQueue = useCallback(
    (tracks: QueueTrack[], startIndex: number): void => {
      if (tracks.length === 0) return
      const safeIndex = startIndex >= 0 && startIndex < tracks.length ? startIndex : 0
      originRef.current = null
      resetRecovery()
      lastFailureRef.current = null

      if (shuffleRef.current) {
        setEntries(shuffleFrom(tracks, safeIndex))
        setIndex(0)
      } else {
        setEntries(tracks)
        setIndex(safeIndex)
      }
      // Forces a reload even when the same row is played twice.
      setPlayRequestId((value) => value + 1)
    },
    [resetRecovery]
  )

  const restore = useCallback(
    (tracks: QueueTrack[], startIndex: number, positionMs: number, autoPlay = false): void => {
      if (tracks.length === 0) return
      const safeIndex = startIndex >= 0 && startIndex < tracks.length ? startIndex : 0
      originRef.current = null
      resetRecovery()
      lastFailureRef.current = null
      // Keep a restore at position 0 on the seek path too. A null here means
      // "normal load", which starts playback; a paused restore must not.
      resumeRef.current = Number.isFinite(positionMs) ? Math.max(0, Math.round(positionMs)) : 0
      resumePlayRef.current = autoPlay
      setEntries(tracks)
      setIndex(safeIndex)
      // The load effect keys off `current`, so an unchanged index would not reload;
      // the request id makes "restore over the same track" work too.
      setPlayRequestId((value) => value + 1)
    },
    [resetRecovery]
  )

  const enqueue = useCallback(
    (tracks: QueueTrack[]): void => {
      if (tracks.length === 0) return
      const queue = entriesRef.current
      if (queue.length === 0) {
        resetRecovery()
        setEntries(tracks)
        setIndex(0)
        setPlayRequestId((value) => value + 1)
        return
      }
      originRef.current = originRef.current ? [...originRef.current, ...tracks] : null
      setEntries([...queue, ...tracks])
    },
    [resetRecovery]
  )

  const removeAt = useCallback((position: number): void => {
    const queue = entriesRef.current
    if (position < 0 || position >= queue.length) return

    const playing = queue[indexRef.current] ?? null
    const removed = queue[position]
    const remaining = queue.filter((_, at) => at !== position)
    // The un-shuffled order is a different order, so the index cannot be reused;
    // remove the same entry by identity instead.
    originRef.current = removed ? (originRef.current?.filter((track) => track !== removed) ?? null) : null

    if (remaining.length === 0) {
      wantsPlayRef.current = false
      resetRecovery()
      audioRef.current?.pause()
      setEntries([])
      setIndex(-1)
      setIsPlaying(false)
      return
    }

    const playingPosition = playing ? remaining.indexOf(playing) : -1
    setEntries(remaining)
    setIndex(playingPosition >= 0 ? playingPosition : Math.min(indexRef.current, remaining.length - 1))
  }, [resetRecovery])

  /**
   * Reorders the visible queue.
   *
   * A drop while shuffle is on is still a real instruction, so the same relative
   * move is applied to the saved un-shuffled order when one exists. Otherwise
   * turning shuffle off would put the track back where it started and make the
   * drag look like it did nothing.
   */
  const move = useCallback((from: number, to: number): void => {
    const queue = entriesRef.current
    if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return

    const playing = queue[indexRef.current] ?? null
    const moved = queue[from]
    if (!moved) return

    const next = [...queue]
    next.splice(from, 1)
    next.splice(to, 0, moved)

    const origin = originRef.current
    if (origin) {
      const originFrom = origin.indexOf(moved)
      if (originFrom >= 0) {
        const originNext = [...origin]
        originNext.splice(originFrom, 1)
        // The row after the moved one is the anchor: inserting before it in the
        // un-shuffled order keeps the two orders as close as they can be.
        const follower = next[to + 1] ?? null
        const followerAt = follower ? originNext.indexOf(follower) : -1
        if (followerAt >= 0) originNext.splice(followerAt, 0, moved)
        else originNext.push(moved)
        originRef.current = originNext
      }
    }

    setEntries(next)
    if (playing) {
      const playingPosition = next.indexOf(playing)
      if (playingPosition !== indexRef.current) setIndex(playingPosition)
    }
  }, [])

  const removePlayed = useCallback((): void => {
    const queue = entriesRef.current
    const position = indexRef.current
    if (position <= 0 || queue.length === 0) return

    const played = queue.slice(0, position)
    const remaining = queue.slice(position)
    if (originRef.current) {
      const playedSet = new Set(played)
      originRef.current = originRef.current.filter((track) => !playedSet.has(track))
    }
    setEntries(remaining)
    setIndex(0)
  }, [])

  const clearQueue = useCallback((): void => {
    wantsPlayRef.current = false
    resetRecovery()
    audioRef.current?.pause()
    originRef.current = null
    setEntries([])
    setIndex(-1)
    setIsPlaying(false)
  }, [resetRecovery])

  const jumpTo = useCallback(
    (position: number): void => {
      const queue = entriesRef.current
      if (position < 0 || position >= queue.length) return
      if (position === indexRef.current) {
        // Re-selecting the playing row is also how a stuck stream is restarted.
        resetRecovery()
        setPlayRequestId((value) => value + 1)
        return
      }
      setIndex(position)
    },
    [resetRecovery]
  )

  const toggle = useCallback((): void => {
    const element = audio()
    if (!currentTrackRef.current) return

    // A media element that has errored will not start again from `play()`: the
    // request it is holding is dead. Reloading it is the only way out, and that
    // is what the recovery path does.
    if (element.error || !element.currentSrc) {
      // Either the last load failed or it never got a source (a resolve
      // deadline). `play()` cannot help in both cases; reload the token.
      wantsPlayRef.current = true
      retryNow()
      return
    }

    if (element.paused) {
      wantsPlayRef.current = true
      audioChainRef.current?.resume()
      void element.play().catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'NotAllowedError') {
          setIsLoading(false)
          return
        }
        if (currentTrackRef.current?.sourceKind === 'youtube') {
          scheduleRecoveryRef.current()
          return
        }
        setIsLoading(false)
      })
    } else {
      wantsPlayRef.current = false
      resetRecovery()
      element.pause()
    }
  }, [audio, resetRecovery, retryNow])

  const next = useCallback((): void => {
    advance(false)
  }, [advance])

  /** Media "stop": pause and rewind, unlike play/pause which keeps the position. */
  const stop = useCallback((): void => {
    const element = audio()
    wantsPlayRef.current = false
    resetRecovery()
    element.pause()
    element.currentTime = 0
    lastPositionRef.current = 0
    setPositionMs(0)
  }, [audio, resetRecovery])

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
      const element = audio()
      if (!audioChainRef.current?.setVolume(clamped)) element.volume = clamped
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
    reconnecting,
    positionMs,
    durationMs,
    volume,
    error,
    playQueue,
    restore,
    enqueue,
    removeAt,
    move,
    removePlayed,
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
