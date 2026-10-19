/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages serves project sites under /<repo-name>/ — keep in sync with the repo name
  base: '/here-mapmatching-poc/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
