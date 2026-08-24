module.exports = {
  apps: [
    {
      name: 'vg-epaper-ingest',
      script: 'src/server.js',
      cwd: __dirname,
      interpreter: 'node',
      // This service shells out to pdftoppm/pdftotext per PDF and isn't
      // CPU-bound on the Node side — one instance is enough. Don't run this
      // in cluster mode; multiple workers would just race to claim the same
      // incoming webhook, not add throughput.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      // server.js already runs `import 'dotenv/config'` itself, so pm2 does
      // NOT need an env_file option here — .env is loaded by the app, same
      // as running it directly with `node src/server.js`.
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
