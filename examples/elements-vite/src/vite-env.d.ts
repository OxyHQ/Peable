/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional: the gateway the Elements talk to. Default `https://api.peable.to`. */
  readonly VITE_PEABLE_API_URL?: string;
}
