/**
 * Toque de chamada de entrada do webphone, gerado com Web Audio (sem ficheiro).
 *
 * Os browsers só deixam tocar som depois de um gesto do utilizador na página.
 * Por isso o AudioContext é criado/retomado em `unlock()`, chamado ao escolher
 * a linha e em qualquer clique; quando a chamada chegar já está autorizado.
 */

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let gain: GainNode | null = null;

export function unlockRingtone(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    // Sem Web Audio: a chamada continua a aparecer no ecrã, só não toca.
  }
}

/** Um "trim-trim": duas rajadas de 0,4 s com dois tons (como um telefone). */
function ringOnce(): void {
  if (!ctx || !gain) return;
  const t0 = ctx.currentTime;
  for (const start of [0, 0.6]) {
    for (const freq of [440, 480]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(t0 + start);
      osc.stop(t0 + start + 0.4);
    }
  }
}

export function startRingtone(): void {
  if (timer) return;
  unlockRingtone();
  if (!ctx) return;
  gain = ctx.createGain();
  gain.gain.value = 0.15;
  gain.connect(ctx.destination);
  ringOnce();
  timer = setInterval(ringOnce, 3000);
}

export function stopRingtone(): void {
  if (timer) clearInterval(timer);
  timer = null;
  // Desligar o gain corta também a rajada que estiver a meio.
  gain?.disconnect();
  gain = null;
}
