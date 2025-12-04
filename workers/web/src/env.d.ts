/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_CONVEX_URL: string;
  readonly PUBLIC_AUTH0_DOMAIN: string;
  readonly PUBLIC_AUTH0_CLIENT_ID: string;
  readonly PUBLIC_API_URL: string;
  readonly PUBLIC_TINYBIRD_API_URL: string;
  readonly NEXT_PUBLIC_CONVEX_URL: string;
  readonly NEXT_PUBLIC_AUTH0_DOMAIN: string;
  readonly NEXT_PUBLIC_AUTH0_CLIENT_ID: string;
  readonly NEXT_PUBLIC_API_URL: string;
  readonly NEXT_PUBLIC_TINYBIRD_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
