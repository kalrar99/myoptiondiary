// src/setupProxy.js
// Precise proxy configuration for CRA development server.
// Only proxies /api and /health to the backend on port 3002.
// Explicitly disables websocket proxying (ws: false) so the
// webpack-dev-server HMR websocket is never forwarded to the backend.

const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function (app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://localhost:3002',
      changeOrigin: true,
      ws: false,           // never proxy websocket upgrades
      logLevel: 'silent',  // suppress [HPM] noise in terminal
    })
  );
  app.use(
    '/health',
    createProxyMiddleware({
      target: 'http://localhost:3002',
      changeOrigin: true,
      ws: false,
      logLevel: 'silent',
    })
  );
};
