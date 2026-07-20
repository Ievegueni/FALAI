import fp from "fastify-plugin";
import { OtpCallService } from "../services/OtpCallService.js";

declare module "fastify" {
  interface FastifyInstance {
    otpCallService: OtpCallService;
  }
}

export default fp(async (fastify) => {
  const service = new OtpCallService(fastify.log);

  fastify.decorate("otpCallService", service);
  fastify.log.info("otp_call_service.initialized");
});
