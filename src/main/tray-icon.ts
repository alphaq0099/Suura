/**
 * The tray icon, embedded rather than loaded from disk.
 *
 * Electron's tray needs a bitmap, and the main bundle has no public directory
 * that would survive packaging. A 32 px PNG is 657 bytes: small enough to keep
 * here without a build step, and self-contained in both dev and a future
 * installer. The image is the brand mark (accent disc, white play triangle) at
 * 2x, so Windows can pick the right size for the display's scale factor.
 */
export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAImSURBVFhH1ZexSgNBEIZTWlpa+giWlnmElHamFBNRCyFYqGAjSSSKRSCFhY1aaaWFoJ1pApYBG0ELsRCxMaKw40xuLsnt/ZfbuySFP3wcuZudmZ3dm71k/q1W9s18oULZQfTRZLRcpplCxSwVq+a6WCWKgm2afC2t1mhWh44mdjTNs9vhwB07WDymLomrq+TySms+sHNXTId9LKhLd/HgfLpZY6SK6jpePICDY0ejYWoaIlpS9nHO3EY2soYKS3f6iGseh+lwnDkNGZSUCA/qs9XA95PAk7zQkH3J7F1Kf3VP9PJGdHiOn7sSqgLfLNlGCEnAV6tNtFnHdvGYuob2xGWRDgYMgwwmIPr59e6tH2D7aMyrhva6HTYKYyfg6/2TqHGJx0TRWwY5WJABIioBX4/PRLvHeKxNr0Pyj5z9MIq4BHzdtog2jrAPn0LZrHUTkOaADBCuCYi+von2TrAfodeepRTIAOGagOOrWtIEpP1CgxBxCcisz27wWEC+m4DXhKBBiGEJuKz7ILL5uwmI+L18QkY2KIEkO7+P6Sxu05SGdzsHhMEE0rz7PqHzQJoCMrSRBNJ3vwA5Dd2XZAUMA8jOTt//fcyDhgzKtQpjIDx7X/zQ6VRMj3UKIrHRKR48GrzEzcDOj5IYjTsJCS6nroZwk/Rq5Cw5pu40cyT9Sr7DjofDs27zNXrDJZE48pbF5ZO9+//R6/OTkB5eJVkii2yyUmcyf7zX2K9KZ0BRAAAAAElFTkSuQmCC'
