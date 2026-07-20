import fp from "fastify-plugin";
import type { YeastarAdapter } from "@falai/providers";
import { CampaignDispatcher } from "../services/campaignDispatcher.js";

export default fp(async (fastify) => {
  const dispatcher = new CampaignDispatcher(
    fastify.yeastar as YeastarAdapter,
    fastify.callEngine,
    fastify.log
  );

  fastify.addHook("onReady", () => {
    dispatcher.start();
    fastify.log.info("campaign_dispatcher.started");
  });

  fastify.addHook("onClose", () => {
    dispatcher.stop();
    fastify.log.info("campaign_dispatcher.stopped");
  });
});
