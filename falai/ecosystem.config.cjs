module.exports = {
  apps: [
    {
      name: "falai-api",
      cwd: "/srv/projects/FALAI/falai/apps/api",
      script: "dist/index.js",
      interpreter: "/srv/projects/FALAI/falai/node_modules/.bin/tsx",
      interpreter_args: "--env-file=/srv/projects/FALAI/falai/.env",
      env: { NODE_ENV: "production" },
      restart_delay: 5000,
    },
    {
      name: "falai-worker",
      cwd: "/srv/projects/FALAI/falai/apps/worker",
      script: "dist/index.js",
      interpreter: "/srv/projects/FALAI/falai/node_modules/.bin/tsx",
      interpreter_args: "--env-file=/srv/projects/FALAI/falai/.env",
      env: { NODE_ENV: "production" },
      restart_delay: 5000,
    },
  ],
};
