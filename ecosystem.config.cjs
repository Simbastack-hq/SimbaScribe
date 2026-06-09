// PM2 ecosystem config for SimbaScribe's listener.
//
// CommonJS (.cjs) because PM2's config loader doesn't handle ESM, even when the
// rest of the project is ESM.
//
// Replace <writer-user> and <repo-path> with your values. Conventions:
// - hardcoded absolute Node interpreter path (don't rely on PATH / a version
//   manager default)
// - filter_env strips any CLAUDECODE leak from a Claude-Code-started session
// - logs go to ~/.pm2/logs/ (PM2 default; configure logrotate separately)
//
// Only the LISTENER runs under PM2. The synth + snapshot run under system cron
// (PM2 fork-mode can deadlock with better-sqlite3) — see crontab.example.
module.exports = {
  apps: [
    {
      name: 'simbascribe-listener',
      cwd: '<repo-path>',
      script: 'dist/listener/index.js',
      interpreter: '/home/<writer-user>/.nvm/versions/node/v20.20.1/bin/node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production',
      },
      filter_env: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
      out_file: '/home/<writer-user>/.pm2/logs/simbascribe-listener-out.log',
      error_file: '/home/<writer-user>/.pm2/logs/simbascribe-listener-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
