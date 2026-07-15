/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FLAG_CAMERA?: string;
  readonly VITE_FLAG_UPLOAD?: string;
  readonly VITE_FLAG_GOOGLE_OAUTH?: string;
  readonly VITE_FLAG_DARK_MODE?: string;
  readonly VITE_FLAG_ANIMATIONS?: string;
  readonly VITE_FLAG_RECENT_SCANS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
