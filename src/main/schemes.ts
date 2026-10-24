import { protocol } from 'electron'
import { ARTWORK_SCHEME } from '@shared/artwork-url'
import { MEDIA_SCHEME } from '@shared/media-url'
import { STREAM_SCHEME } from '@shared/stream-url'

/**
 * Declares the custom schemes as privileged. Must run before the app is ready.
 *
 * The schemes go in a single call on purpose: `registerSchemesAsPrivileged`
 * installs the whole list at once, so splitting it across three modules risks
 * the later call replacing the first rather than adding to it.
 *
 * `stream` is only set for media. It is what lets an <audio> element issue range
 * requests instead of buffering the entire file; images have no need for it.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Web Audio's MediaElementAudioSourceNode reads the decoded samples as
        // a cross-origin resource. The handler answers with an allow-origin
        // header; this makes Chromium honour CORS for the scheme at all.
        corsEnabled: true,
        stream: true
      }
    },
    {
      scheme: ARTWORK_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Media Session artwork can be fetched in CORS mode when Chromium hands
        // it to the Windows overlay. The handler answers with an allow-origin
        // header, so enabling it here keeps <img> and the OS path both working.
        corsEnabled: true
      }
    },
    {
      // The remote stream proxy. `stream` is what lets the audio element issue
      // range requests into the CDN instead of waiting for a whole file.
      scheme: STREAM_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true
      }
    }
  ])
}
