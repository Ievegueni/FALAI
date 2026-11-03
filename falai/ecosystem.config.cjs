module.exports = {
  apps: [
    {
      name: "falai-api",
      cwd: "/srv/projects/FALAI/falai/apps/api",
      script: "dist/index.js",
      // node com o loader do tsx (os pacotes @falai/* exportam .ts): um só processo,
      // para o PM2 medir a memória do processo certo e o max_memory_restart funcionar.
      interpreter: "node",
      node_args: "--import tsx --env-file=/srv/projects/FALAI/falai/.env",
      env: { NODE_ENV: "production" },
      restart_delay: 5000,
      max_memory_restart: "700M",
    },
    {
      name: "falai-worker",
      cwd: "/srv/projects/FALAI/falai/apps/worker",
      script: "dist/index.js",
      // node com o loader do tsx (os pacotes @falai/* exportam .ts): um só processo,
      // para o PM2 medir a memória do processo certo e o max_memory_restart funcionar.
      interpreter: "node",
      node_args: "--import tsx --env-file=/srv/projects/FALAI/falai/.env",
      env: { NODE_ENV: "production" },
      restart_delay: 5000,
      max_memory_restart: "400M",
    },
  ],
};
