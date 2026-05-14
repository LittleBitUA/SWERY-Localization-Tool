// DP2 in-game dialogue mockup — показує, як рядок виглядатиме у грі.
// Не реальний рендер двигуна, а стилізована імітація: shape, шрифти, рамка,
// підсвітка плейсхолдерів. Допомагає одразу побачити, чи влізе текст,
// чи не "втікає" placeholder, чи не порушені переноси.

import { useT } from "../lib/i18n";
import type { FlatEntry } from "../types";

interface Props {
  entry: FlatEntry;
}

// Інлайнові теги формату, які гра РЕНДЕРИТЬ (а не показує як placeholder):
// курсив [i]…[/i] / <i>…</i>, болд [b]…[/b] / <b>…</b>, колір
// [color=…]…[/color] / <color=…>…</color>. Решта `{…}`/`[…]`/`<…>` —
// це engine-токени (плейсхолдери, переноси, лічильники), і їх показуємо як
// бурштинові чіпи, щоб локалізатор бачив де вони стоять.

interface ParsedTag {
  /** opening як написане у тексті ("[i]", "<color=red>" тощо). */
  raw: string;
  tag: string;        // нормалізоване (lowercase)
  attr?: string;      // те, що після "="
  bracket: "[" | "<"; // тип брекета (для пошуку відповідного closer)
}

function parseOpeningTag(slice: string): ParsedTag | null {
  // [tag] / [tag=attr]
  let m = slice.match(/^\[(\w+)(?:=([^\]]+))?\]/);
  if (m) return { raw: m[0], tag: m[1].toLowerCase(), attr: m[2], bracket: "[" };
  // <tag> / <tag=attr>
  m = slice.match(/^<(\w+)(?:=([^>]+))?>/);
  if (m) return { raw: m[0], tag: m[1].toLowerCase(), attr: m[2], bracket: "<" };
  return null;
}

function closerFor(open: ParsedTag): string {
  return open.bracket === "[" ? `[/${open.tag}]` : `</${open.tag}>`;
}

const FORMAT_TAGS = new Set(["i", "b", "color"]);

let __keyCounter = 0;
function nextKey() { return `n${__keyCounter++}`; }

function renderFormattedText(text: string): React.ReactNode[] {
  __keyCounter = 0;
  return renderRange(text);
}

function renderRange(text: string): React.ReactNode[] {
  if (!text) return [];
  const out: React.ReactNode[] = [];
  let i = 0;
  let buf = "";
  const flushBuf = () => {
    if (!buf) return;
    // Розбиваємо буфер по \n на справжні переноси.
    const parts = buf.split("\n");
    parts.forEach((p, idx) => {
      if (p) out.push(p);
      if (idx < parts.length - 1) out.push(<br key={nextKey()} />);
    });
    buf = "";
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch !== "[" && ch !== "<" && ch !== "{") {
      buf += ch;
      i++;
      continue;
    }

    // Спроба розпарсити opening tag
    if (ch === "[" || ch === "<") {
      const opening = parseOpeningTag(text.slice(i));
      if (opening && FORMAT_TAGS.has(opening.tag)) {
        // шукаємо відповідний closer
        const closer = closerFor(opening);
        const contentStart = i + opening.raw.length;
        const contentEnd = text.indexOf(closer, contentStart);
        if (contentEnd >= 0) {
          flushBuf();
          const inner = text.slice(contentStart, contentEnd);
          const innerNodes = renderRange(inner);
          if (opening.tag === "i") {
            out.push(<i key={nextKey()}>{innerNodes}</i>);
          } else if (opening.tag === "b") {
            out.push(<b key={nextKey()}>{innerNodes}</b>);
          } else if (opening.tag === "color") {
            const color = parseColor(opening.attr);
            out.push(<span key={nextKey()} style={color ? { color } : undefined}>{innerNodes}</span>);
          }
          i = contentEnd + closer.length;
          continue;
        }
      }
    }

    // Спроба розпарсити engine-токен як placeholder-чіп.
    const phMatch =
      ch === "{"
        ? text.slice(i).match(/^\{[^{}]*\}/)
        : ch === "["
          ? text.slice(i).match(/^\[[^\[\]\n]+\]/)
          : text.slice(i).match(/^<\/?[a-zA-Z][^<>]*>/);
    if (phMatch) {
      flushBuf();
      const m = phMatch[0];
      out.push(
        <span
          key={nextKey()}
          className="inline-flex items-center px-1 mx-0.5 rounded text-[10px] font-mono align-middle"
          style={{
            background: "rgba(240, 180, 41, 0.18)",
            border: "1px solid rgba(240, 180, 41, 0.5)",
            color: "#f0b429",
            lineHeight: 1.2,
          }}
        >
          {m}
        </span>
      );
      i += m.length;
      continue;
    }

    // Звичайний символ "[" / "<" / "{", що не утворив токен — у буфер.
    buf += ch;
    i++;
  }
  flushBuf();
  return out;
}

function parseColor(attr: string | undefined): string | null {
  if (!attr) return null;
  const a = attr.trim();
  // 0xRRGGBB → #RRGGBB
  if (/^0x[0-9a-fA-F]{6}$/.test(a)) return "#" + a.slice(2);
  // #RRGGBB / #RGB
  if (/^#[0-9a-fA-F]{3,8}$/.test(a)) return a;
  // named (red, blue …)
  if (/^[a-zA-Z]+$/.test(a)) return a;
  return null;
}

// Стрипаємо теги для виміру "візуальної" довжини рядка (без token-боксів).
const TAG_RE_STRIP = /\{[^{}]*\}|<\/?[a-zA-Z][^<>]*>|\[[^\[\]\n]+\]/g;

export function DialoguePreview({ entry }: Props) {
  const t = useT();
  const isSentence = entry.kind === "sentence";
  const text = entry.en || "";
  const speaker = isSentence ? (entry.charaName ?? "") : "";
  const itemName = !isSentence ? (entry.itemName ?? "") : "";

  // Орієнтовний "ліміт" символів у грі (огрублено):
  // діалоги DP2 ~40 симв * 3 рядки = ~120, без врахування плейсхолдерів.
  const visualText = text.replace(TAG_RE_STRIP, "X"); // X замість token, грубо
  const visualLen = visualText.replace(/\s+/g, " ").trim().length;
  const isLong = isSentence ? visualLen > 130 : visualLen > 80;

  if (isSentence) {
    const displayName = speaker || entry.charaNameJp;
    return (
      <div className="dp-preview-sentence" style={{ overflowX: "auto" }}>
        {/* Імітація гри: субтитри пливуть на темному фоні без рамки/бокса.
            Контейнер має ФІКСОВАНУ ширину — preview не змінюється від resize
            бокової панелі. Якщо вікно занадто вузьке — з'явиться скрол. */}
        <div
          className="relative"
          style={{
            background:
              "radial-gradient(ellipse 80% 60% at 50% 75%, rgba(0,0,0, 0.55) 0%, rgba(0,0,0, 0.85) 100%)",
            borderRadius: 4,
            padding: "20px 24px 32px",
            minHeight: 110,
            width: 440,
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "flex-end",
            fontFamily: '"DP2-Cinema", "Inter", "Segoe UI", system-ui, sans-serif',
            overflow: "hidden",
          }}
        >
          {/* Name plate: інлайн-блок, щоб підкреслення йшло лише під ім'ям
              + 22-24px по краях (як у грі — табличка-плашка).
              Метрики шрифту з гри: m_Tracking=1 ≈ +0.06em letter-spacing. */}
          {displayName && (
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
              <span
                style={{
                  display: "inline-block",
                  color: "#ffffff",
                  fontSize: 12,
                  letterSpacing: "0.06em",
                  paddingBottom: 3,
                  paddingLeft: 24,
                  paddingRight: 24,
                  borderBottom: "1px solid rgba(255,255,255, 0.7)",
                  textShadow: "0 1px 3px rgba(0,0,0, 0.95)",
                }}
              >
                {displayName}
              </span>
            </div>
          )}

          {/* Body — велике, по центру.
              Метрики з гри: FontSize=16, LineSpacing=32 → line-height = 2.0,
              Tracking=1 → letter-spacing ≈ 0.06em.
              ВАЖЛИВО: один контейнер з `pre` (без авто-wrap, з твоїми \n),
              щоб span'и [i]…[/i] правильно охоплювали кілька рядків. */}
          <div
            style={{
              color: "#ffffff",
              fontSize: 16,
              lineHeight: 2,
              letterSpacing: "0.06em",
              textAlign: "center",
              textShadow: "0 1px 4px rgba(0,0,0, 0.95), 0 0 12px rgba(0,0,0, 0.5)",
              maxWidth: "100%",
              overflow: "hidden",
              whiteSpace: "pre",
            }}
          >
            {text ? renderFormattedText(text) : (
              <span style={{ color: "rgba(255,255,255, 0.3)", fontStyle: "italic", fontSize: 13 }}>
                {t("preview.empty")}
              </span>
            )}
          </div>

          {/* Continue arrow ▽ — як у грі справа знизу */}
          <div
            style={{
              position: "absolute",
              bottom: 8,
              right: 14,
              color: "rgba(255,255,255, 0.65)",
              fontSize: 10,
              textShadow: "0 1px 2px rgba(0,0,0, 0.9)",
            }}
          >
            ▽
          </div>
        </div>

        {isLong && (
          <p className="text-[10px] text-[var(--warning)] mt-1.5 italic">
            ⚠ {t("preview.tooLong")}
          </p>
        )}
      </div>
    );
  }

  // ITEM mode
  return (
    <div className="dp-preview-item" style={{ overflowX: "auto" }}>
      <div
        className="relative"
        style={{
          background:
            "linear-gradient(180deg, rgba(30,22,16, 0.98) 0%, rgba(15,11,7, 0.98) 100%)",
          border: "1px solid rgba(212, 167, 58, 0.55)",
          borderRadius: 4,
          padding: "10px 14px",
          width: 440,
          margin: "0 auto",
          boxShadow:
            "0 4px 16px rgba(0,0,0, 0.5), inset 0 0 0 1px rgba(212, 167, 58, 0.1)",
          fontFamily: '"DP2-Cinema", "Inter", "Segoe UI", system-ui, sans-serif',
        }}
      >
        {/* Item title */}
        {itemName && (
          <div
            style={{
              color: "#f5cc55",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.04em",
              marginBottom: 6,
              borderBottom: "1px solid rgba(212, 167, 58, 0.25)",
              paddingBottom: 4,
              textShadow: "0 1px 2px rgba(0,0,0, 0.8)",
            }}
          >
            {itemName}
          </div>
        )}

        {/* Description — ті ж метрики з гри (FontSize=16, LineSpacing=32) */}
        <div
          style={{
            color: "#e0d6c0",
            fontSize: 14,
            lineHeight: 2,
            letterSpacing: "0.06em",
            minHeight: 24,
            textShadow: "0 1px 2px rgba(0,0,0, 0.7)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {text ? renderFormattedText(text) : (
            <span style={{ color: "rgba(255,255,255, 0.25)", fontStyle: "italic" }}>
              {t("preview.empty")}
            </span>
          )}
        </div>
      </div>

      {isLong && (
        <p className="text-[10px] text-[var(--warning)] mt-1.5 italic">
          ⚠ {t("preview.tooLong")}
        </p>
      )}
    </div>
  );
}
