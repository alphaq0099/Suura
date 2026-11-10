// Serves the Suura downloads and feed files from the R2 bucket through
// Cloudflare's edge. The bucket's r2.dev hostname is rate-limited and meant for
// development; a Worker on workers.dev is not, and its free plan allows 100,000
// requests a day, which is far more headroom than a download button needs.
//
//   https://suura-downloads.<account>.workers.dev/Suura-Setup.exe
//   https://suura-downloads.<account>.workers.dev/Suura.AppImage
//
// Only known release files are exposed. Everything else is a 404, so the bucket
// can keep holding objects that should not be public at this hostname.

const VERSIONED = /^Suura-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:-Setup\.exe|\.AppImage)(?:\.blockmap)?$/

function allowed(key) {
  return (
    key === 'Suura-Setup.exe' ||
    key === 'Suura.AppImage' ||
    key === 'SHA256SUMS.txt' ||
    key === 'latest.yml' ||
    key === 'beta.yml' ||
    key === 'latest-linux.yml' ||
    key === 'beta-linux.yml' ||
    VERSIONED.test(key)
  )
}

function notFound() {
  return new Response('Not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const key = decodeURIComponent(url.pathname.replace(/^\//, ''))

    if (!allowed(key)) return notFound()

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed\n', {
        status: 405,
        headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }
      })
    }

    const rangeHeader = request.headers.get('range')
    let object
    try {
      object = await env.BUCKET.get(key, rangeHeader ? { range: request.headers } : undefined)
    } catch {
      return new Response('Range not satisfiable\n', { status: 416 })
    }

    if (!object) return notFound()

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('etag', object.httpEtag)
    headers.set('accept-ranges', 'bytes')
    headers.set('x-content-type-options', 'nosniff')
    headers.set(
      'cache-control',
      VERSIONED.test(key) ? 'public, max-age=31536000, immutable' : 'no-cache, max-age=0, must-revalidate'
    )
    if (key.endsWith('.exe') || key.endsWith('.AppImage')) {
      headers.set('content-disposition', `attachment; filename="${key}"`)
    }

    const body = request.method === 'HEAD' ? null : object.body

    if (rangeHeader) {
      if (!object.range) {
        return new Response('Range not satisfiable\n', {
          status: 416,
          headers: { 'content-range': `bytes */${object.size}` }
        })
      }
      const start = object.range.offset
      const end = start + object.range.length - 1
      headers.set('content-range', `bytes ${start}-${end}/${object.size}`)
      headers.set('content-length', String(object.range.length))
      return new Response(body, { status: 206, headers })
    }

    headers.set('content-length', String(object.size))
    return new Response(body, { status: 200, headers })
  }
}
