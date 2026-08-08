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
    description: 'Translate any page in place, translating only what you can actually see',
    permissions: ['storage', 'unlimitedStorage', 'activeTab', 'tabs'],
    host_permissions: ['https://translate.googleapis.com/*'],
  },
});
