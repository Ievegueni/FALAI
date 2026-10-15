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

/** Bip curto e agudo (três notas a subir): "chamada da fila a entrar" — diferente do toque normal. */
export function playQueueAlert(): void {
  unlockRingtone();
  if (!ctx) return;
  const g = ctx.createGain();
  g.gain.value = 0.2;
  g.connect(ctx.destination);
  const t0 = ctx.currentTime;
  [880, 1175, 1568].forEach((freq, i) => {
    const osc = ctx!.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(g);
    osc.start(t0 + i * 0.15);
    osc.stop(t0 + i * 0.15 + 0.12);
  });
}

/** Dois bips curtos: "chamada atendida automaticamente, já está em linha". */
export function playAutoAnswerBeep(): void {
  unlockRingtone();
  if (!ctx) return;
  const g = ctx.createGain();
  g.gain.value = 0.2;
  g.connect(ctx.destination);
  const t0 = ctx.currentTime;
  [0, 0.18].forEach((start) => {
    const osc = ctx!.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1000;
    osc.connect(g);
    osc.start(t0 + start);
    osc.stop(t0 + start + 0.1);
  });
}

// ─── Sinal de chamada (chamada de saída) ────────────────────────────────────
// O Asterisk não manda áudio antes de o cliente atender (Dial sem early media),
// por isso o agente ouvia silêncio. Tom europeu, o de Angola: 425 Hz, 1 s ligado, 4 s desligado.
let rbTimer: ReturnType<typeof setInterval> | null = null;
let rbGain: GainNode | null = null;

function ringbackOnce(): void {
  if (!ctx || !rbGain) return;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 425;
  osc.connect(rbGain);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 1);
}

export function startRingback(): void {
  if (rbTimer) return;
  unlockRingtone();
  if (!ctx) return;
  rbGain = ctx.createGain();
  rbGain.gain.value = 0.1;
  rbGain.connect(ctx.destination);
  ringbackOnce();
  rbTimer = setInterval(ringbackOnce, 5000);
}

export function stopRingback(): void {
  if (rbTimer) clearInterval(rbTimer);
  rbTimer = null;
  rbGain?.disconnect();
  rbGain = null;
}
