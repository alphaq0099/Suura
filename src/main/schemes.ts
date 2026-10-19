import { protocol } from 'electron'
import { ARTWORK_SCHEME } from '@shared/artwork-url'
import { MEDIA_SCHEME } from '@shared/media-url'
import { STREAM_SCHEME } from '@shared/stream-url'

/**
 * Declares the custom schemes as privileged. Must run before the app is ready.
 *
 * Both schemes go in a single call on purpose: `registerSchemesAsPrivileged`
 * installs the whole list at once, so splitting it across two modules risks the
 * second call replacing the first rather than adding to it.
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
        stream: true
      }
    },
    {
      scheme: ARTWORK_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true
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
        stream: true
      }
    }
  ])
}
