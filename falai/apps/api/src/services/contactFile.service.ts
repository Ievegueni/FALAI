/**
 * Ficheiro de números para campanhas (voz e SMS): lê CSV/Excel, normaliza os
 * números e devolve os contactos a usar — os que já existem são reutilizados
 * tal como estão (não se gravam de novo nem se lhes muda o nome) e só os que
 * faltam são criados.
 *
 * A identidade é o NÚMERO: a campanha liga/envia para o número principal do
 * contacto. Um nome igual a outro já existente mas com número diferente tem de
 * ser um contacto novo (senão esse número nunca era contactado) — fica
 * assinalado em `nameMatches` para quem carregou o ficheiro decidir.
 */
import { parse as csvParse } from "csv-parse/sync";
import * as XLSX from "xlsx";
import { prisma } from "@falai/db";
import { normalizeAoPhone } from "@falai/shared";

export const MAX_FILE_CONTACTS = 5000; // o mesmo limite de contactos por campanha

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const PHONE_KEYS = new Set(["phone", "telefone", "numero", "telemovel", "contacto", "celular", "msisdn", "mobile", "tel"]);
const NAME_KEYS = new Set(["name", "nome", "cliente", "contact name"]);

export interface FileRow {
  row: number; // linha no ficheiro (1-based), para mostrar ao utilizador
  rawPhone: string;
  name: string | null;
}

/** Lê CSV (vírgula ou ponto e vírgula) ou Excel para uma tabela de texto. */
export function readTable(buffer: Buffer, filename: string): string[][] {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0] ?? ""];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" }).map((r) => r.map((c) => String(c ?? "").trim()));
  }
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
    return (csvParse(text, { delimiter, skip_empty_lines: true, relax_column_count: true, trim: true }) as string[][]);
  }
  throw new Error("Formato não suportado. Use .csv, .txt ou .xlsx");
}

/**
 * Encontra as colunas do número e do nome. Com cabeçalho reconhecido usa-o;
 * sem cabeçalho (ex. um número por linha), a coluna do número é a que tem
 * mais números válidos e o nome é a primeira outra coluna com texto.
 */
export function extractRows(table: string[][]): FileRow[] {
  const rows = table.filter((r) => r.some((c) => c !== ""));
  if (rows.length === 0) return [];
  const head = rows[0]!.map(strip);
  let phoneCol = head.findIndex((h) => PHONE_KEYS.has(h));
  let nameCol = head.findIndex((h) => NAME_KEYS.has(h));
  let start = 1;
  if (phoneCol < 0) {
    // Sem cabeçalho de telefone: a 1.ª linha é dados se tiver um número válido.
    const isData = rows[0]!.some((c) => normalizeAoPhone(c) !== null);
    start = isData ? 0 : 1;
    const sample = rows.slice(start, start + 50);
    const width = Math.max(...rows.map((r) => r.length));
    let best = -1;
    let bestHits = 0;
    for (let c = 0; c < width; c++) {
      const hits = sample.filter((r) => normalizeAoPhone(r[c] ?? "") !== null).length;
      if (hits > bestHits) {
        best = c;
        bestHits = hits;
      }
    }
    phoneCol = best;
    if (nameCol < 0) {
      nameCol = Array.from({ length: width }, (_, c) => c).find(
        (c) => c !== phoneCol && sample.some((r) => (r[c] ?? "") !== "" && normalizeAoPhone(r[c] ?? "") === null)
      ) ?? -1;
    }
  }
  if (phoneCol < 0) return [];
  return rows.slice(start).map((r, i) => ({
    row: start + i + 1,
    rawPhone: (r[phoneCol] ?? "").trim(),
    name: nameCol >= 0 && (r[nameCol] ?? "").trim() !== "" ? r[nameCol]!.trim() : null,
  }));
}

export interface ResolvedContact {
  id: string;
  name: string | null;
  phone: string;
  status: "existing" | "created";
}

export interface FileResolution {
  contacts: ResolvedContact[];
  summary: { rows: number; valid: number; existing: number; created: number; duplicatesInFile: number; invalid: number };
  invalid: { row: number; raw: string; reason: string }[];
  /** Nome já existe noutro contacto com outro número (criado na mesma — ver cabeçalho). */
  nameMatches: { row: number; name: string; phone: string; existingPhone: string | null }[];
}

/** Normaliza, junta repetidos e separa os inválidos (puro — testável). */
export function normalizeRows(rows: FileRow[]) {
  const invalid: FileResolution["invalid"] = [];
  const byPhone = new Map<string, { phone: string; name: string | null; row: number }>();
  let duplicates = 0;
  for (const r of rows) {
    if (!r.rawPhone) {
      invalid.push({ row: r.row, raw: r.name ?? "", reason: "Sem número" });
      continue;
    }
    const phone = normalizeAoPhone(r.rawPhone);
    if (!phone) {
      invalid.push({ row: r.row, raw: r.rawPhone, reason: "Número inválido (use 9 dígitos, ex. 923456789)" });
      continue;
    }
    const seen = byPhone.get(phone);
    if (seen) {
      duplicates++;
      if (!seen.name && r.name) seen.name = r.name; // fica com o nome, se a repetição o trouxer
      continue;
    }
    byPhone.set(phone, { phone, name: r.name, row: r.row });
  }
  return { unique: [...byPhone.values()], invalid, duplicates };
}

const chunks = <T,>(xs: T[], n = 1000) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function resolveContactsFromFile(tenantId: string, rows: FileRow[]): Promise<FileResolution> {
  const { unique, invalid, duplicates } = normalizeRows(rows);
  if (unique.length > MAX_FILE_CONTACTS) {
    throw new Error(`O ficheiro tem ${unique.length} números; o máximo por campanha é ${MAX_FILE_CONTACTS}`);
  }

  // Já existentes: número principal (também no formato antigo +244…) ou número extra.
  const existing = new Map<string, { id: string; name: string | null }>();
  for (const part of chunks(unique.map((u) => u.phone))) {
    const variants = part.flatMap((p) => [p, `+244${p}`, `244${p}`]);
    const [main, extra] = await Promise.all([
      prisma.contact.findMany({ where: { tenantId, phone: { in: variants } }, select: { id: true, name: true, phone: true } }),
      prisma.contactPhone.findMany({ where: { tenantId, phone: { in: part } }, select: { phone: true, contact: { select: { id: true, name: true } } } }),
    ]);
    for (const c of main) existing.set(normalizeAoPhone(c.phone!) ?? c.phone!, { id: c.id, name: c.name });
    for (const x of extra) if (!existing.has(x.phone)) existing.set(x.phone, x.contact);
  }

  const toCreate = unique.filter((u) => !existing.has(u.phone));

  // Nomes iguais a contactos existentes com outro número — assinalar, não juntar.
  const nameMatches: FileResolution["nameMatches"] = [];
  const names = [...new Set(toCreate.map((u) => u.name).filter((n): n is string => !!n))];
  if (names.length > 0) {
    const same = new Map<string, string | null>();
    for (const part of chunks(names, 500)) {
      const found = await prisma.contact.findMany({
        where: { tenantId, OR: part.map((n) => ({ name: { equals: n, mode: "insensitive" as const } })) },
        select: { name: true, phone: true },
      });
      for (const f of found) if (f.name) same.set(strip(f.name), f.phone);
    }
    for (const u of toCreate) {
      if (u.name && same.has(strip(u.name))) nameMatches.push({ row: u.row, name: u.name, phone: u.phone, existingPhone: same.get(strip(u.name)) ?? null });
    }
  }

  for (const part of chunks(toCreate)) {
    await prisma.contact.createMany({
      data: part.map((u) => ({ tenantId, phone: u.phone, ...(u.name && { name: u.name }) })),
      skipDuplicates: true, // corrida com outro pedido: o único (tenantId, phone) decide
    });
  }
  const created = new Map<string, { id: string; name: string | null }>();
  for (const part of chunks(toCreate.map((u) => u.phone))) {
    const rowsDb = await prisma.contact.findMany({ where: { tenantId, phone: { in: part } }, select: { id: true, name: true, phone: true } });
    for (const c of rowsDb) created.set(c.phone!, { id: c.id, name: c.name });
  }

  const contacts: ResolvedContact[] = [];
  for (const u of unique) {
    const e = existing.get(u.phone);
    const c = created.get(u.phone);
    if (e) contacts.push({ id: e.id, name: e.name, phone: u.phone, status: "existing" });
    else if (c) contacts.push({ id: c.id, name: c.name, phone: u.phone, status: "created" });
  }

  return {
    contacts,
    summary: {
      rows: rows.length,
      valid: unique.length,
      existing: contacts.filter((c) => c.status === "existing").length,
      created: contacts.filter((c) => c.status === "created").length,
      duplicatesInFile: duplicates,
      invalid: invalid.length,
    },
    invalid: invalid.slice(0, 100),
    nameMatches: nameMatches.slice(0, 100),
  };
}
