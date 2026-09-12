/**
 * Gravação das chamadas.
 *
 * O campo Call.recordingUrl já existia no schema e o CRM já tinha o leitor de
 * áudio pronto, mas ninguém gravava nada nem escrevia o campo — o
 * pbxCdr.service.ts chegava a pô-lo explicitamente a null.
 *
 * Grava-se a BRIDGE e não o canal: um canal só traz a voz do seu próprio lado,
 * a bridge traz a conversa. Quem decide é o cliente (Tenant.recordCalls); o
 * caminho onde os ficheiros ficam e o formato são definições da plataforma,
 * configuradas no backoffice.
 *
 * O ficheiro nunca é servido directamente ao browser: guarda-se o caminho
 * relativo e a rota /tenant/calls/:id/recording é que o lê, já com o dono da
 * chamada validado.
 */
import type { AsteriskAdapter } from "@falai/providers";
import type { FastifyBaseLogger } from "fastify";
import { prisma } from "@falai/db";
import { getSetting } from "./settings.service.js";

export const RECORDING_DIR_SETTING = "RECORDING_DIR";
export const RECORDING_FORMAT_SETTING = "RECORDING_FORMAT";
export const RECORDING_ANNOUNCE_PROMPT_SETTING = "RECORDING_ANNOUNCE_PROMPT";

/**
 * Ogg Vorbis: cerca de seis vezes menor do que WAV sem perda audível numa
 * chamada de 8 kHz, e o browser toca-o sem conversão nenhuma. O módulo
 * format_ogg_vorbis vem no pacote asterisk-modules da imagem base.
 */
export const DEFAULT_RECORDING_FORMAT = "ogg";
export const DEFAULT_ANNOUNCE_PROMPT = "aviso-gravacao";

/**
 * Formatos que o Asterisk sabe gravar e que aceitamos escrever no URL do ARI e
 * no nome do ficheiro. Lista fechada de propósito: o valor vem de uma definição
 * editável no backoffice e acaba num caminho de ficheiro.
 */
const ALLOWED_FORMATS = new Set(["ogg", "wav", "wav49", "gsm", "alaw", "ulaw", "g722"]);

/** Mesma regra dos prompts do IVR — o nome acaba num caminho de ficheiro. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

export interface RecordingSettings {
  /** Pasta onde os ficheiros aparecem, vista pela API. Vazia = gravação desligada. */
  dir: string;
  format: string;
  announcePrompt: string;
}

export async function recordingSettings(): Promise<RecordingSettings> {
  const [dir, format, prompt] = await Promise.all([
    getSetting(RECORDING_DIR_SETTING),
    getSetting(RECORDING_FORMAT_SETTING),
    getSetting(RECORDING_ANNOUNCE_PROMPT_SETTING),
  ]);
  return {
    dir: (dir ?? "").trim(),
    format: normalize(format, ALLOWED_FORMATS.has.bind(ALLOWED_FORMATS), DEFAULT_RECORDING_FORMAT),
    announcePrompt: normalize(prompt, (v) => SAFE_NAME.test(v), DEFAULT_ANNOUNCE_PROMPT),
  };
}

function normalize(value: string | null, valid: (v: string) => boolean, fallback: string): string {
  const trimmed = (value ?? "").trim();
  return trimmed && valid(trimmed) ? trimmed : fallback;
}

/** O ficheiro desta chamada, relativo à pasta de gravações. */
export function recordingFileName(callId: string, format: string): string {
  return `${callId}.${format}`;
}

/**
 * Arranca a gravação de uma chamada já atendida, se o cliente a tiver ligada.
 *
 * O aviso ("esta chamada pode ser gravada") toca DEPOIS de a gravação começar,
 * de propósito: assim fica dentro do próprio ficheiro e serve de prova de que
 * foi dado.
 *
 * Nada aqui pode derrubar a chamada: falhar a gravar é mau, desligar uma
 * chamada em curso por causa disso é pior.
 */
export async function startCallRecording(params: {
  callId: string;
  tenantId: string;
  bridgeId: string;
  asterisk: AsteriskAdapter;
  log: FastifyBaseLogger;
}): Promise<void> {
  const { callId, tenantId, bridgeId, asterisk, log } = params;
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { recordCalls: true, recordingAnnounce: true },
    });
    if (!tenant?.recordCalls) return;

    const settings = await recordingSettings();
    if (!settings.dir) {
      // Sem pasta configurada o ficheiro ficava só dentro do contentor do
      // Asterisk, invisível para a API — uma gravação que ninguém consegue ouvir.
      log.warn({ callId, tenantId }, "call_recording.dir_not_configured");
      return;
    }

    await asterisk.recordBridge(bridgeId, callId, settings.format);
    log.info({ callId, tenantId, format: settings.format }, "call_recording.started");

    if (tenant.recordingAnnounce) {
      await asterisk
        .playMediaOnBridge(bridgeId, settings.announcePrompt)
        .catch((err) => log.error({ err, callId }, "call_recording.announce_failed"));
    }
  } catch (err) {
    log.error({ err, callId, tenantId }, "call_recording.start_failed");
  }
}

/**
 * Fecha a gravação da chamada. Chamado quando o canal do trunk morre: a bridge
 * pode ficar viva depois disso, e sem este fecho o ficheiro ficava aberto muito
 * depois de a conversa ter acabado.
 */
export async function stopCallRecording(
  callId: string,
  asterisk: AsteriskAdapter,
  log: FastifyBaseLogger
): Promise<void> {
  await asterisk.stopRecording(callId).catch((err) => {
    log.warn({ err, callId }, "call_recording.stop_failed");
  });
}

/**
 * Liga o ficheiro à chamada. O nome da gravação É o id da linha na tabela Call
 * — é assim que se sabe de que chamada é, já que o evento de fim de gravação
 * não traz canal nenhum.
 */
export async function saveFinishedRecording(
  recordingName: string,
  format: string,
  log: FastifyBaseLogger
): Promise<void> {
  const effectiveFormat = ALLOWED_FORMATS.has(format) ? format : (await recordingSettings()).format;
  try {
    const updated = await prisma.call.updateMany({
      where: { id: recordingName },
      data: { recordingUrl: recordingFileName(recordingName, effectiveFormat) },
    });
    if (updated.count === 0) {
      // Gravação sem chamada: não é nossa (ou a linha foi apagada entretanto).
      log.warn({ recordingName }, "call_recording.call_not_found");
      return;
    }
    log.info({ callId: recordingName, format: effectiveFormat }, "call_recording.saved");
  } catch (err) {
    log.error({ err, recordingName }, "call_recording.save_failed");
  }
}
