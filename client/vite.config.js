import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev: Vite serves on 5173, Express on 3000. The proxy below forwards
// /api/* to Express so the React app can use same-origin relative URLs in
// both dev and prod.
//
// In prod: Railway runs `cd client && npm install && npm run build`, then
// Express serves client/dist as static. There is no proxy in prod —
// VITE_API_URL must be empty/unset on Railway so the bundle uses relative
// URLs against the same origin (CLAUDE.md gotcha #7).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow {subdomain}.localhost so we can hit the dev server as
    // momentum.localhost:5173 and exercise the real subdomain
    // resolver. Vite blocks unknown hosts by default as DNS-rebinding
    // protection; the leading "." here is "any subdomain of localhost."
    allowedHosts: ['.localhost'],
    proxy: {
      // /api/* gets forwarded to the Express backend on :3000.
      //
      // Vite/http-proxy DOES NOT preserve the original Host header by
      // default (despite changeOrigin being false) — Node's http client
      // sets Host from the target URL when not explicitly given. We
      // need it to pass through unchanged so Express's resolveTenant
      // can read momentum.localhost off the request and extract the
      // subdomain. The configure hook below explicitly copies the
      // original Host header onto the proxied request.
      '/api': {
        target: 'http://localhost:3000',
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.headers.host) {
              proxyReq.setHeader('Host', req.headers.host);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
