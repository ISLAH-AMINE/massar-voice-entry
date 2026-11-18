import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset paths: works at https://<user>.github.io/<repo>/ and locally
  base: './',
  server: { port: 5174, strictPort: true },
});
