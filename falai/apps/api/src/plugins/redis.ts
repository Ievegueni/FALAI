import fp from "fastify-plugin";
import { Redis } from "ioredis";
import { config } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(async (fastify) => {
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  await redis.connect();

  fastify.decorate("redis", redis);
  fastify.addHook("onClose", async () => redis.quit());
});
