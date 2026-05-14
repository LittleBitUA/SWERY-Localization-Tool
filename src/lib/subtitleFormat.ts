// Smart line-break для субтитрів. Цілі:
//   • Не розривати слова: переноси тільки на пробілах
//   • Балансувати довжину рядків (професійні субтитри прагнуть симетрії)
//   • Віддавати перевагу розривам після пунктуації
//   • Уникати "сирітських" коротких прийменників/сполучників у кінці рядка
//
// Стандартні рекомендації для UA-субтитрів: ~37-42 символи на рядок,
// максимум 2 рядки. Якщо в 2 не вміщається — greedy-розбиття.

const SHORT_LEADING = new Set([
  "і", "й", "а", "в", "у", "з", "на", "до", "по", "за", "при",
  "від", "для", "без", "та", "як", "що", "не", "та", "чи", "бо",
  "is", "to", "of", "in", "on", "at", "a", "an", "the", "or", "if",
]);

function isShortLeading(word: string): boolean {
  // Прибираємо trailing-пунктуацію перед перевіркою
  const clean = word.replace(/[.,!?:;—–-]+$/u, "").toLowerCase();
  return SHORT_LEADING.has(clean);
}

const PUNCT_END = new Set([".", ",", "!", "?", ";", ":", "—", "–"]);

function endsWithPunct(word: string): boolean {
  if (!word) return false;
  return PUNCT_END.has(word[word.length - 1]);
}

export interface BreakOpts {
  /** Цільова довжина рядка у видимих символах (рекомендовано 37-42). */
  maxLine?: number;
  /** Максимум рядків. За замовч. 2. Якщо не вміщається — greedy. */
  maxLines?: number;
}

/**
 * Розкладає текст по рядках "драбинкою" — балансовані по довжині,
 * без розриву слів, з урахуванням пунктуації.
 *
 * ВАЖЛИВО: зберігає існуючі переноси:
 *   • Leading/trailing \n у тексті залишаються недоторканими (як у JSON-форматі).
 *   • Параграфи (розділені порожніми рядками) обробляються незалежно.
 *   • Параграф, у якому юзер уже поставив свій \n, НЕ переламується.
 *     Драбинка торкається лише суцільних довгих рядків.
 */
export function smartSubtitleBreak(text: string, opts: BreakOpts = {}): string {
  if (!text) return text;
  // Окремо запам'ятовуємо leading/trailing \n.
  let leading = 0;
  let middle = text;
  while (middle.startsWith("\n")) { leading++; middle = middle.slice(1); }
  let trailing = 0;
  while (middle.endsWith("\n")) { trailing++; middle = middle.slice(0, -1); }

  if (!middle) return text; // нема що балансувати

  // Розділяємо параграфи за порожніми рядками (\n\n+). Структура зберігається.
  const paragraphs = middle.split(/\n{2,}/);
  const rebuilt = paragraphs.map((p) => {
    // Якщо параграф уже має свій \n — це навмисний поділ юзера, не чіпаємо.
    if (p.includes("\n")) return p;
    return rebalanceSingleLine(p, opts);
  });

  // Відновлюємо leading/trailing \n у незмінному вигляді.
  return "\n".repeat(leading) + rebuilt.join("\n\n") + "\n".repeat(trailing);
}

function rebalanceSingleLine(line: string, opts: BreakOpts): string {
  const maxLine = opts.maxLine ?? 38;
  const maxLines = opts.maxLines ?? 2;

  // Нормалізуємо whitespace всередині рядка (поодинокі пробіли).
  const flat = line.replace(/[ \t]+/g, " ").trim();
  if (!flat || flat.length <= maxLine) return flat;
  const words = flat.split(" ");
  if (words.length < 2) return flat;

  if (maxLines >= 2) {
    const two = bestTwoLineBreak(words, maxLine);
    if (two) return two;
  }
  return greedyFill(words, maxLine);
}

function bestTwoLineBreak(words: string[], maxLine: number): string | null {
  const n = words.length;
  // cumWord[k] = сумарна довжина перших k слів (без пробілів між ними)
  const cumWord: number[] = [0];
  for (let k = 0; k < n; k++) cumWord.push(cumWord[k] + words[k].length);
  const total = cumWord[n];

  let bestI = -1;
  let bestScore = Infinity;
  for (let i = 0; i < n - 1; i++) {
    // Розрив ПІСЛЯ слова[i]: line1 = words[0..i], line2 = words[i+1..n-1]
    const line1Len = cumWord[i + 1] + i;                     // i пробілів між i+1 словами
    const line2Len = (total - cumWord[i + 1]) + (n - i - 2); // (n-i-1) слів, (n-i-2) пробілів
    if (line1Len > maxLine || line2Len > maxLine) continue;

    let score = Math.abs(line1Len - line2Len);
    const w = words[i];
    if (endsWithPunct(w)) score -= 12;       // після пунктуації — природній розрив
    if (isShortLeading(w)) score += 15;       // не залишати сирітський прийменник
    if (score < bestScore) {
      bestScore = score;
      bestI = i;
    }
  }
  if (bestI === -1) return null;
  return words.slice(0, bestI + 1).join(" ") + "\n" + words.slice(bestI + 1).join(" ");
}

function greedyFill(words: string[], maxLine: number): string {
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (next.length > maxLine && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}
