import { authenticator } from "otplib";
import QRCode from "qrcode";
import { writeFileSync } from "fs";
import { generateTotpSecretNative, generateTotpNative, verifyTotpNative } from "../apps/api/src/services/totp.native.js";

async function main() {
// ── Configuração ──────────────────────────────────────────────────────────────

const CONTA = "teste@falai.ao";
const APP   = "Falaí";

// ── 1. Gerar segredo nativo ───────────────────────────────────────────────────

const secret = generateTotpSecretNative();
const otpauthUrl = authenticator.keyuri(CONTA, APP, secret);

console.log("\n═══════════════════════════════════════════════");
console.log("  TOTP — Teste com app real (Authenticator)");
console.log("═══════════════════════════════════════════════\n");
console.log(`Segredo (Base32) : ${secret}`);
console.log(`otpauth URL      : ${otpauthUrl}\n`);

// ── 2. Gerar QR Code em HTML para escanear ───────────────────────────────────

const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { width: 300 });


const html = `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <title>TOTP — Falaí Teste</title>
  <style>
    body { font-family: sans-serif; max-width: 480px; margin: 60px auto; text-align: center; color: #111; }
    img  { margin: 24px 0; border: 1px solid #ddd; border-radius: 8px; padding: 12px; }
    code { background: #f4f4f4; padding: 4px 10px; border-radius: 4px; font-size: 14px; }
    .secret { font-size: 13px; word-break: break-all; background: #f9f9f9; padding: 12px; border-radius: 8px; margin: 12px 0; }
  </style>
</head>
<body>
  <h2>Escaneia com o Google Authenticator ou Authy</h2>
  <img src="${qrDataUrl}" alt="QR Code TOTP" width="300" height="300">
  <p>Ou introduz manualmente o segredo:</p>
  <div class="secret"><code>${secret}</code></div>
  <p style="color:#666;font-size:13px">Conta: <strong>${CONTA}</strong> · App: <strong>${APP}</strong></p>
</body>
</html>`;

writeFileSync("/tmp/totp-test.html", html);
console.log("QR Code gerado → abre este ficheiro no browser:");
console.log("  /tmp/totp-test.html\n");

// ── 3. Mostrar código actual e verificar em loop ──────────────────────────────

console.log("Código actual (nativo) :", generateTotpNative(secret));
console.log("Código actual (otplib) :", authenticator.generate(secret));
console.log("\nComo testar:");
console.log("  1. Abre /tmp/totp-test.html no browser e escaneia o QR");
console.log("  2. O app vai mostrar um código de 6 dígitos");
console.log("  3. Copia o código e corre:");
console.log(`     npx tsx scripts/test-totp.ts verify ${secret} <CÓDIGO>\n`);

// ── 4. Modo verify — valida um código introduzido manualmente ─────────────────

const [,, mode, argSecret, argToken] = process.argv;

if (mode === "verify" && argSecret && argToken) {
  console.log("═══════════════════════════════════════════════");
  console.log("  VERIFICAÇÃO MANUAL");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Segredo : ${argSecret}`);
  console.log(`  Token   : ${argToken}`);

  const nativo = verifyTotpNative(argSecret, argToken);
  const otplib = authenticator.verify({ token: argToken, secret: argSecret });

  console.log(`  Nativo  : ${nativo ? "✓ VÁLIDO" : "✗ INVÁLIDO"}`);
  console.log(`  otplib  : ${otplib ? "✓ VÁLIDO" : "✗ INVÁLIDO"}`);
  console.log("═══════════════════════════════════════════════\n");
}
}

main();
