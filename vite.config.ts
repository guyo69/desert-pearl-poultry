import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * `npm run dev`: serves api/gateway.ts at /api/gateway like Vercel does, so the
 * cookie sign-in works locally. Put SUPABASE_URL, SUPABASE_ANON_KEY and
 * DPV_GATEWAY_SECRET in .env.local (never commit it).
 */
function devGateway(): Plugin {
  return {
    name: 'dpv-dev-gateway',
    configureServer(server) {
      Object.assign(process.env, loadEnv('development', process.cwd(), ''));
      server.middlewares.use('/api/gateway', async (req, res) => {
        const mod = await server.ssrLoadModule('/api/gateway.ts');
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        headers.set('x-real-ip', req.socket.remoteAddress ?? '127.0.0.1');
        const url = `https://${req.headers.host}/api/gateway${req.url ?? ''}`;
        const r: Response = await mod.default(new Request(url, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }));
        res.statusCode = r.status;
        r.headers.forEach((v, k) => { if (k !== 'set-cookie') res.setHeader(k, v); });
        const cookies = (r.headers as Headers & { getSetCookie(): string[] }).getSetCookie();
        if (cookies.length) res.setHeader('set-cookie', cookies);
        res.end(Buffer.from(await r.arrayBuffer()));
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    devGateway(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      // the password-strength dictionaries (~1.7 MB) load only on password screens, never into the offline cache
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], globIgnores: ['**/zxcvbn-*.js'] },
      manifest: {
        name: 'Desert Pearl Poultry Manager',
        short_name: 'Desert Pearl',
        description: 'Farm, stock and money management for Tuala Farm Fresh Eggs',
        theme_color: '#F2F2F7',
        background_color: '#F2F2F7',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    chunkSizeWarningLimit: 1300,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('@zxcvbn-ts/language-common') ? 'zxcvbn-common'
          : id.includes('@zxcvbn-ts/language-en') ? 'zxcvbn-en' : id.includes('@zxcvbn-ts/core') ? 'zxcvbn-core' : undefined),
      },
    },
  },
});
