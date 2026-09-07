/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** HERE Platform API key（Base Plan），.env 提供，可缺省（缺省走 Mock） */
  readonly VITE_HERE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
