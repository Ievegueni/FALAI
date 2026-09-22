/**
 * Normalização de números de telefone para armazenamento.
 *
 * O formato canónico em base de dados é o **nacional angolano de 9 dígitos,
 * sem indicativo** (ex: "923456789"). É o que a PBX espera encaminhar e o que
 * o cliente vê no CRM.
 *
 * Existiam três implementações divergentes disto — a rota `/tenant/contacts`
 * gravava 9 dígitos, a `/v1/contacts` e o worker de importação gravavam
 * `+244…`. O mesmo contacto criado por vias diferentes ficava duplicado em
 * base, porque a chave única é (tenantId, phone).
 */
const AO_COUNTRY_CODE = "244";
const NATIONAL_LENGTH = 9;

/**
 * Devolve o número nacional de 9 dígitos, ou `null` se não for um número
 * angolano reconhecível. Aceita "+244923456789", "244923456789",
 * "00244923456789" e "923456789", com ou sem espaços e pontuação.
 */
export function normalizeAoPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");

  if (digits.startsWith("00" + AO_COUNTRY_CODE) && digits.length === 5 + NATIONAL_LENGTH) {
    return digits.slice(5);
  }
  if (digits.startsWith(AO_COUNTRY_CODE) && digits.length === 3 + NATIONAL_LENGTH) {
    return digits.slice(3);
  }
  if (digits.length === NATIONAL_LENGTH) return digits;

  return null;
}

/** Formato E.164, para APIs externas que o exijam. Não é o formato de gravação. */
export function toE164(nationalPhone: string): string {
  return `+${AO_COUNTRY_CODE}${nationalPhone}`;
}

/**
 * Mensagem de erro para um número que não passa no `normalizeAoPhone`.
 * Vive aqui para que todas as rotas que aceitam números digam o mesmo ao
 * cliente, em vez de cada uma inventar a sua redacção.
 */
export const INVALID_PHONE_MESSAGE =
  "Invalid phone number. Use the 9-digit Angolan national format (e.g. 923456789).";
