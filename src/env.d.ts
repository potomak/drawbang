/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_INGEST_URL?: string;
  readonly VITE_STATE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
