import { mergeLibrarySearch } from '@shared/search'
import type { LibrarySearchResult } from '@shared/types'
import type { AppContainer } from './services/container'

/** How many rows each half of a live search may return. */
export const LIBRARY_SEARCH_LIMIT = 30

/**
 * One live search across local files and database-only YouTube rows.
 *
 * Local FTS and the two imported tables are read in the same main-process turn,
 * so the renderer gets a single grouped answer and never sees one shelf update
 * before the other. YouTube is not touched here: that request stays explicit
 * and costs the engine its own call.
 */
export function searchLibrary(
  container: AppContainer,
  query: string,
  limit = LIBRARY_SEARCH_LIMIT
): LibrarySearchResult {
  const local = container.library.list({ search: query, limit }).tracks
  const history = container.onlineRepo.search(query, limit)
  const playlistMatches = container.onlinePlaylists.search(query, limit)
  return mergeLibrarySearch(local, history, playlistMatches, limit)
}
