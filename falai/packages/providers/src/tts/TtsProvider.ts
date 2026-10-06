export interface TtsProvider {
  synthesize(params: {
    text: string;
    voiceId: string;
    language?: string;
  }): Promise<{ wavBuffer: Buffer; durationMs: number; characters: number }>;

  healthCheck(): Promise<{ ok: boolean; details?: string }>;

  /**
   * Vozes que o provedor aceita, para validar um voiceId antes de o gravar.
   * Devolve `null` quando a lista não pode ser obtida (modo stub, provedor
   * inacessível) — nesse caso quem chama deve deixar passar em vez de bloquear.
   */
  listVoices(): Promise<Array<{ voiceId: string; name: string }> | null>;
}
