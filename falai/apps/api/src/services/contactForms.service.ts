import { z } from "zod";

/**
 * Fichas de recolha de dados durante a chamada. Cada campo grava-se em
 * Contact.attributes pela sua chave — a mesma chave em fichas diferentes é o
 * mesmo dado do cliente (ex.: "nif" preenchido numa campanha aparece na outra).
 */

export const FIELD_TYPES = ["text", "number", "date", "email", "select", "yesno", "nif", "bi", "province"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
/** Só aparece (e só se exige) quando o campo `key` tem o valor `equals`. */
export type ShowIf = { key: string; equals: string | boolean };
export type FormField = { key: string; label: string; type: FieldType; required: boolean; options?: string[]; showIf?: ShowIf };

/** As 21 províncias (divisão político-administrativa de 2024). */
export const PROVINCES = [
  "Bengo", "Benguela", "Bié", "Cabinda", "Cuando", "Cuanza Norte", "Cuanza Sul", "Cubango", "Cunene", "Huambo", "Huíla",
  "Ícolo e Bengo", "Luanda", "Lunda Norte", "Lunda Sul", "Malanje", "Moxico", "Moxico Leste", "Namibe", "Uíge", "Zaire",
];

// ponytail: só o formato — sem dígito de controlo, cuja regra não está publicada.
/** BI: 9 dígitos, 2 letras da província de emissão, 3 dígitos (ex.: 004567890LA042). */
export const isBi = (s: string) => /^\d{9}[A-Z]{2}\d{3}$/.test(s);
/** NIF: pessoa singular usa o nº do BI; empresa tem 10 dígitos. */
export const isNif = (s: string) => isBi(s) || /^\d{10}$/.test(s);

const fieldSchema = z.object({
  key: z.string().trim().max(40).optional(), // os novos recebem a chave a partir do rótulo
  label: z.string().trim().min(1).max(120),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  showIf: z.object({ key: z.string().min(1).max(40), equals: z.union([z.string().max(120), z.boolean()]) }).optional(),
});
export const fieldsSchema = z.array(fieldSchema).min(1).max(60);

/** "Data de nascimento" → "data_de_nascimento". Pura. */
export const slugKey = (label: string) =>
  label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "campo";

export class FormError extends Error {}

/**
 * Valida a definição e dá chave única aos campos novos (os existentes mantêm a
 * sua). A condição só pode apontar para um campo sim/não ou lista que venha
 * antes. Pura.
 */
export function normalizeFields(input: unknown): FormField[] {
  const out: FormField[] = [];
  for (const f of fieldsSchema.parse(input)) {
    if (f.type === "select" && !f.options?.length) throw new FormError(`O campo "${f.label}" precisa de opções`);
    const base = slugKey(f.key || f.label);
    let key = base;
    for (let i = 2; out.some((o) => o.key === key); i++) key = `${base}_${i}`;
    let showIf: ShowIf | undefined;
    if (f.showIf) {
      const parent = out.find((o) => o.key === f.showIf!.key);
      if (!parent || (parent.type !== "yesno" && parent.type !== "select")) {
        throw new FormError(`"${f.label}": a condição tem de ser um campo sim/não ou lista que venha antes`);
      }
      showIf = { key: parent.key, equals: parent.type === "yesno" ? f.showIf.equals === true || f.showIf.equals === "true" : String(f.showIf.equals) };
    }
    out.push({
      key,
      label: f.label,
      type: f.type,
      required: f.required,
      ...(f.type === "select" && { options: f.options! }),
      ...(showIf && { showIf }),
    });
  }
  return out;
}

/** O campo aparece com estes valores? Pura. */
export const isVisible = (f: FormField, values: Record<string, unknown>) => !f.showIf || values[f.showIf.key] === f.showIf.equals;

/**
 * Valida os valores contra os campos e devolve só os dos campos visíveis, já
 * no tipo certo. Vazio num campo opcional = null (apaga o dado). Um campo
 * escondido pela condição não entra (o que o cliente já tinha fica). Pura.
 */
export function cleanValues(fields: FormField[], values: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const f of fields) {
    if (!isVisible(f, { ...values, ...out })) continue;
    const raw = values[f.key];
    const empty = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
    if (empty) {
      if (f.required) throw new FormError(`Preencha "${f.label}"`);
      out[f.key] = null;
      continue;
    }
    const s = String(raw).trim().slice(0, 1000);
    switch (f.type) {
      case "number": {
        const n = Number(s.replace(",", "."));
        if (!Number.isFinite(n)) throw new FormError(`"${f.label}" tem de ser um número`);
        out[f.key] = n;
        break;
      }
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new FormError(`"${f.label}" tem de ser uma data`);
        out[f.key] = s;
        break;
      case "email":
        if (!z.string().email().safeParse(s).success) throw new FormError(`"${f.label}" tem de ser um email`);
        out[f.key] = s.toLowerCase();
        break;
      case "nif":
      case "bi": {
        const v = s.replace(/[\s.-]/g, "").toUpperCase();
        if (!(f.type === "bi" ? isBi(v) : isNif(v))) {
          throw new FormError(f.type === "bi" ? `"${f.label}": BI inválido (ex.: 004567890LA042)` : `"${f.label}": NIF inválido (BI ou 10 dígitos)`);
        }
        out[f.key] = v;
        break;
      }
      case "province":
        if (!PROVINCES.includes(s)) throw new FormError(`"${f.label}": província inválida`);
        out[f.key] = s;
        break;
      case "select":
        if (!f.options?.includes(s)) throw new FormError(`"${f.label}": opção inválida`);
        out[f.key] = s;
        break;
      case "yesno":
        if (raw !== true && raw !== false) throw new FormError(`"${f.label}": responda sim ou não`);
        out[f.key] = raw;
        break;
      default:
        out[f.key] = s;
    }
  }
  return out;
}

/** Campos que contam para "perfil completo": os que não dependem de condição. Pura. */
export const completenessKeys = (fields: FormField[]) => fields.filter((f) => !f.showIf).map((f) => f.key);
