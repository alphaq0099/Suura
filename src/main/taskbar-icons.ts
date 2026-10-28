import { nativeImage, type NativeImage } from 'electron'

type TaskbarIconId = 'previous' | 'play' | 'pause' | 'next'

/**
 * White glyphs for the Windows taskbar thumbnail toolbar.
 *
 * The thumbnails sit on a dark surface regardless of the app theme, so the
 * icons are white on transparency. Generating them from base64 keeps packaging
 * free of loose asset paths and means `setThumbarButtons` never has to read a
 * file from disk on the UI thread.
 */
const PNG_BASE64: Record<TaskbarIconId, string> = {
  previous:
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAWklEQVR42u2WQQoAIAzDfKf//0e8epIhjhZpYNcZZK6OEUJwB5idVTl8p9IUpQAqAS5u6pkAKoET7QKoBKpE4F8B+RDaPEOLRWSzii3CqDWO5R+SCEQgAq21AFEegA+e0T8LAAAAAElFTkSuQmCC',
  next: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAWElEQVR42u3WsQ0AIAhEUeZ0/z2+rYWJkhBBvUto4RUqmimKclOAFl3e4Ww2HhMOoAJg1fwYgAqA2aAUABUAOM6JAG8C/ryGfz7FqcsodR2nf0gEEECA8Oqi04WDTuo84AAAAABJRU5ErkJggg==',
  play: 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAUElEQVR42u3VwQ0AIAhDUedk/z2+MxAwom0TzrwDoWs5jvNSgOie7HImAJgAaINUAUwAlCCdACYA0pBTAOQBmkeo+Yg0y+hqHYcBBhjwHWADvxxn3VcAQXwAAAAASUVORK5CYII=',
  pause:
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAPklEQVR42u3WsQkAMAgAQefM/nuY3iakEBHuwUpIrjRC0pYy83TMz+e1+thrDwAAAAAAALAfMH6QAAAAtMwFhInP/DB8ntoAAAAASUVORK5CYII='
}

const cache = new Map<TaskbarIconId, NativeImage>()

export function taskbarIcon(id: TaskbarIconId): NativeImage {
  const existing = cache.get(id)
  if (existing) return existing
  const image = nativeImage
    .createFromDataURL(`data:image/png;base64,${PNG_BASE64[id]}`)
    // ThumbarButton is specified at 16x16. The source is 32x32 so the resize
    // has something to work with at higher display scaling.
    .resize({ width: 16, height: 16, quality: 'best' })
  cache.set(id, image)
  return image
}
