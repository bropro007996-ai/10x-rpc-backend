// Standalone Runner for 10X RPC 24/7 Daemon
// Use this if running a separate Render background worker, Docker container, or systemd service.
// Command: npx tsx scripts/rpc-daemon-standalone.ts

import { getRpcDaemon } from '../src/lib/rpc-daemon'

console.log('[10X RPC Standalone Daemon] Booting standalone background daemon process...')

const daemon = getRpcDaemon()
daemon.start().then(() => {
  console.log('[10X RPC Standalone Daemon] Running 24/7. Press Ctrl+C to stop.')
}).catch(err => {
  console.error('[10X RPC Standalone Daemon] Fatal error on startup:', err)
  process.exit(1)
})

process.on('SIGINT', () => {
  console.log('[10X RPC Standalone Daemon] SIGINT received, stopping daemon...')
  daemon.stop()
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('[10X RPC Standalone Daemon] SIGTERM received, stopping daemon...')
  daemon.stop()
  process.exit(0)
})
