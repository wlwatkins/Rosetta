import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  vite: () => ({
    build: {
      // modulepreload links never match in extension pages ("cross-world
      // resource mismatch" console spam) — chunks are small, just skip them.
      modulePreload: false,
    },
  }),
  manifest: {
    name: 'Rosetta',
    description: 'Translate any page in place — Google Translate or your own local LLM',
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'scripting', 'tabs'],
    host_permissions: [
      'https://translate.googleapis.com/*',
      'http://localhost:1234/*',
      'http://127.0.0.1:1234/*',
    ],
  },
});
