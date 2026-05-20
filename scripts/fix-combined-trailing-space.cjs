// Однораз: додає trailing space у два конкретні EN-рядки у combined.txt,
// які текстовий редактор обрізав. Можна видалити після використання.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const file = path.join(os.homedir(), 'Desktop', 'mes_all-combined.txt');
let txt = fs.readFileSync(file, 'utf8');

const patterns = [
  // idx 44
  {
    from: 'EN: The perpetrator from the last case{NEXT_SEGMENT}really was something...',
    to:   'EN: The perpetrator from the last case{NEXT_SEGMENT}really was something... ',
  },
  // idx 46 — apostrophes are literal characters, no escaping needed in plain string
  {
    from: 'EN: "See this? I got this when I{NEXT_SEGMENT} arrested the Catwoman wannabe."{NEXT_FRAME id=199}Women... They\'re crazy.{NEXT_SEGMENT}Don\'t you agree, Zach?',
    to:   'EN: "See this? I got this when I{NEXT_SEGMENT} arrested the Catwoman wannabe."{NEXT_FRAME id=199}Women... They\'re crazy.{NEXT_SEGMENT}Don\'t you agree, Zach? ',
  },
];

let applied = 0;
for (const { from, to } of patterns) {
  // Шукаємо точну форму як цілий рядок (закінчується LF або CRLF).
  // Без regex — split-by-line, заміна, join.
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === from) {
      lines[i] = to;
      applied++;
      break;
    }
  }
  // Reassemble preserving CRLF if it was there
  const hasCRLF = txt.includes('\r\n');
  txt = lines.join(hasCRLF ? '\r\n' : '\n');
}

fs.writeFileSync(file, txt, 'utf8');
console.log('Applied', applied, 'fixes to', file);
