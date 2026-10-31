/**
 * Quota errors with the messages users read (Bahasa Indonesia, plain). HTTP 429 `{ error: { code: 'QUOTA', message, kind,
 * window, limit, used, amount, resetAtMs } }`; the assistant and MCP show `message` as it is.
 */
export type QuotaKind = 'flowCredits' | 'openrouterUsd' | 'elevenChars' | 'llmTurns' | 'genCalls';
/** day = today (UTC+8), d30 = rolling 30 days, render = one request, balance = the shared OpenRouter balance. */
export type QuotaWindow = 'day' | 'd30' | 'render' | 'balance';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** 2.500 — Indonesian thousands separator, no decimals unless the number has them. */
export function num(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const [whole = '0', frac] = String(Math.abs(rounded)).split('.');
  return `${rounded < 0 ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${frac ? `,${frac}` : ''}`;
}

export function usd(n: number): string {
  return `$${n >= 0.01 || n === 0 ? n.toFixed(2) : n.toFixed(4)}`;
}

/** "1 Desember 2026" in WITA. */
export function dateWita(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export type QuotaDetail = { kind: QuotaKind; window: QuotaWindow; limit: number; used: number; amount: number; resetAtMs?: number };

export function quotaMessage(d: QuotaDetail): string {
  const back = d.resetAtMs ? ` Slot pertama kembali sekitar ${dateWita(d.resetAtMs)}.` : '';
  switch (d.kind) {
    case 'elevenChars':
      if (d.window === 'render') return `Satu dubbing maksimal ${num(d.limit)} karakter; yang ini ${num(d.amount)}. Pecah per scene.`;
      if (d.window === 'd30') return `Batas dubbing 30 hari terakhirmu habis (${num(d.used)}/${num(d.limit)} karakter).${back}`;
      return `Batas dubbing hari ini habis: terpakai ${num(d.used)} dari ${num(d.limit)} karakter; dubbing ini ${num(d.amount)} karakter. Coba lagi besok atau persingkat teksnya.`;
    case 'flowCredits':
      if (d.window === 'd30') return `Kuota kredit Flow 30 harimu habis: terpakai ${num(d.used)} dari ${num(d.limit)} kredit; pekerjaan ini butuh ${num(d.amount)}.${back} Minta pengelola menaikkan batasmu bila perlu.`;
      return `Kuota kredit Flow harianmu habis: terpakai ${num(d.used)} dari ${num(d.limit)} kredit hari ini; pekerjaan ini butuh ${num(d.amount)}. Batas direset pukul 00.00 WITA. Minta pengelola menaikkan batasmu bila perlu.`;
    case 'openrouterUsd':
      if (d.window === 'balance') return `Saldo OpenRouter tidak cukup setelah dikurangi pekerjaan yang sedang berjalan: sisa ±${usd(Math.max(0, d.limit - d.used))}, pekerjaan ini butuh ±${usd(d.amount)}.`;
      if (d.window === 'd30') return `Batas saldo OpenRouter 30 harimu tercapai: terpakai ±${usd(d.used)} dari ${usd(d.limit)}; pekerjaan ini butuh ±${usd(d.amount)}.${back}`;
      return `Batas saldo OpenRouter harianmu tercapai: terpakai ±${usd(d.used)} dari ${usd(d.limit)}; pekerjaan ini butuh ±${usd(d.amount)}.`;
    case 'genCalls':
      return `Batas generate harian tercapai (${num(d.used)}/${num(d.limit)}).`;
    case 'llmTurns':
      return `Batas permintaan AI tercapai (${num(d.used)}/${num(d.limit)}). Coba lagi nanti.`;
  }
}

export class QuotaError extends Error {
  readonly code = 'QUOTA' as const;
  readonly kind: QuotaKind;
  readonly window: QuotaWindow;
  readonly limit: number;
  readonly used: number;
  readonly amount: number;
  readonly resetAtMs: number | undefined;

  constructor(detail: QuotaDetail) {
    super(quotaMessage(detail));
    this.name = 'QuotaError';
    this.kind = detail.kind;
    this.window = detail.window;
    this.limit = detail.limit;
    this.used = detail.used;
    this.amount = detail.amount;
    this.resetAtMs = detail.resetAtMs;
  }

  /** Body of the 429 answer. */
  toBody(): { error: { code: 'QUOTA'; message: string; kind: QuotaKind; window: QuotaWindow; limit: number; used: number; amount: number; resetAtMs?: number } } {
    return { error: { code: 'QUOTA', message: this.message, kind: this.kind, window: this.window, limit: this.limit, used: this.used, amount: this.amount, ...(this.resetAtMs === undefined ? {} : { resetAtMs: this.resetAtMs }) } };
  }
}

export function isQuotaError(error: unknown): error is QuotaError {
  return error instanceof QuotaError;
}
