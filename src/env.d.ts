/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_INGEST_URL?: string;
  readonly VITE_STATE_URL?: string;
  // Origin (no trailing slash) where published gif files live.
  // Empty/unset means same-origin — used by `?fork=<id>` to fetch the gif.
  readonly VITE_DRAWING_BASE_URL?: string;
  // Truthy -> hide the "publish to gallery" button (e.g. static demo on GH Pages).
  readonly VITE_DISABLE_PUBLISH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
