import { stat } from 'node:fs/promises'
import type { ResolvedSource, Track } from '@shared/types'
import { buildMediaUrl } from '@shared/media-url'
import { mimeForExtension } from '@shared/mime'
import type { MediaResolver, ResolverCapabilities } from './resolver'

/**
 * Plays files that are already on disk.
 *
 * Resolution is essentially free, but it still does the one check that matters:
 * the file must still exist. That turns "the file was moved" into a clear
 * per-track error instead of a silently dead player.
 */
export class LocalFileResolver implements MediaResolver {
  readonly id = 'local-file'

  readonly capabilities: ResolverCapabilities = {
    streaming: true,
    search: false,
    download: false
  }

  canResolve(track: Track): boolean {
    return track.sourceKind === 'local' && typeof track.filePath === 'string' && track.filePath.length > 0
  }

  async resolve(track: Track): Promise<ResolvedSource> {
    const filePath = track.filePath
    if (!filePath) {
      throw new Error('This track has no file path.')
    }

    let info
    try {
      info = await stat(filePath)
    } catch {
      throw new Error('The file is missing. It may have been moved, renamed or deleted.')
    }
    if (!info.isFile()) {
      throw new Error('The path is not a file.')
    }

    return {
      url: buildMediaUrl(filePath),
      // A file URL never expires, unlike a signed YouTube CDN URL (ROADMAP.md §2.1).
      expiresAt: null,
      mimeType: mimeForExtension(filePath),
      resolverId: this.id
    }
  }
}
