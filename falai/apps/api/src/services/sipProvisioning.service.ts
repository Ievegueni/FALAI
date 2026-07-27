/**
 * Provisionamento nativo de extensões SIP (módulo PBX do Falaí).
 * O Falaí é dono da configuração — gera credenciais de registo, aplica os
 * defaults dos ecrãs (ring 30 s, DTMF RFC4733, sem internacionais) e encripta
 * os segredos. Ver docs/sip_trunk.md §2.
 */
import { randomBytes } from "crypto";
import type { Extension } from "@falai/db";
import { encryptSecret } from "./crypto.service.js";

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomToken(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
  return out;
}

/** Gera credenciais de registo SIP (username estilo Yeastar + segredo forte já encriptado). */
export function generateSipCredentials(): { sipAuthUser: string; sipAuthSecretEncrypted: string; sipAuthSecretPlain: string } {
  const plain = randomToken(24);
  return {
    sipAuthUser: randomToken(10),
    sipAuthSecretEncrypted: encryptSecret(plain),
    sipAuthSecretPlain: plain,
  };
}

/** Defaults por extensão, tirados dos ecrãs do Yeastar (docs/sip_trunk.md §7). */
export const EXTENSION_DEFAULTS = {
  presence: {
    forwarding: {
      internal: { noAnswer: "VOICEMAIL", busy: "VOICEMAIL" },
      external: { noAnswer: "VOICEMAIL", busy: "VOICEMAIL" },
    },
    ringStrategy: { first: ["endpoint", "linkusMobile", "linkusDesktop", "linkusWeb"] },
    ringTimeoutS: 30,
  },
  voicemail: { enabled: true, pinAuth: true, emailNotify: false },
  features: { recording: "NONE", moh: "SYSTEM", businessHours: { tz: "WAT" }, monitored: true },
  voip: { dtmf: "RFC4733", transport: ["UDP", "TCP"], qualify: true, t38: false, srtp: false },
  security: { disallowIntl: true, ipRestriction: false, sipAgentAuth: false },
} as const;

/**
 * Serializa uma extensão para a API sem nunca expor o segredo de registo.
 * `sipAuthUser` é devolvido (o Yeastar também o mostra); o segredo só sai em
 * texto no momento de criar/regenerar.
 */
export function serializeExtension(ext: Extension) {
  return {
    id: ext.id,
    number: ext.number,
    callerId: ext.callerId,
    displayName: ext.displayName,
    email: ext.email,
    mobile: ext.mobile,
    roleId: ext.roleId,
    sipAuthUser: ext.sipAuthUser,
    sipSecretSet: !!ext.sipAuthSecret,
    maxIpRegs: ext.maxIpRegs,
    maxWebRegs: ext.maxWebRegs,
    presence: ext.presence,
    voicemail: ext.voicemail,
    features: ext.features,
    voip: ext.voip,
    security: ext.security,
    isActive: ext.isActive,
    isDefault: ext.isDefault,
    phoneNumber: ext.phoneNumber,
    createdAt: ext.createdAt,
    updatedAt: ext.updatedAt,
  };
}
