/**
 * Converte um ficheiro de áudio qualquer que o browser saiba ler (mp3, m4a,
 * wav, ogg…) para o único formato que o Asterisk toca como .wav: PCM 16-bit,
 * 8 kHz, mono. Feito aqui para o servidor não precisar de ffmpeg.
 * Cópia em apps/crm/src/lib/telephonyWav.ts — manter iguais.
 */
export async function toTelephonyWav(file: File): Promise<Blob> {
  const RATE = 8000;
  const decoded = await new AudioContext().decodeAudioData(await file.arrayBuffer());
  // O OfflineAudioContext a 8 kHz com 1 canal faz o downmix e a reamostragem.
  const ctx = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start();
  const pcm = (await ctx.startRendering()).getChannelData(0);

  const buf = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); buf.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
  buf.setUint32(24, RATE, true); buf.setUint32(28, RATE * 2, true); buf.setUint16(32, 2, true); buf.setUint16(34, 16, true);
  str(36, 'data'); buf.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([buf.buffer], { type: 'audio/wav' });
}
