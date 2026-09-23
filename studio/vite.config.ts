import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Served from https://<user>.github.io/bme690-toolkit/studio/, so every
// asset path is relative to that base.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,svg,png}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: 'BME Studio',
        short_name: 'BME Studio',
        description: 'Import, explore, label and train on BME690/BME688 gas sensor data.',
        theme_color: '#1f6feb',
        background_color: '#111315',
        display: 'standalone',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
    }),
  ],
  worker: { format: 'es' },
});
