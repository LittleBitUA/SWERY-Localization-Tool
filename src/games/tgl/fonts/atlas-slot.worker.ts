// Web Worker: знаходить вільне місце на атласі (alpha=0 у всіх пікселях
// прямокутника). Виноситься у worker, бо scan 4096×4096 — це 16M alpha-reads,
// що блокує main thread на 500-1500ms.
//
// Вхід: { alpha: Uint8Array (width*height), width, height, needW, needH }
//   alpha — лише канал альфа (1 байт/піксель), бо для пошуку RGB не потрібний.
// Вихід: { x, y } або { x: -1, y: -1 } якщо не знайдено.

self.addEventListener("message", (e: MessageEvent) => {
  const { alpha, width, height, needW, needH } = e.data as {
    alpha: Uint8Array;
    width: number;
    height: number;
    needW: number;
    needH: number;
  };
  // rowFree[y*W+x] = скільки прозорих пікселів підряд починаючи з x у y-рядку.
  const rowFree = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    let run = 0;
    const rowStart = y * width;
    for (let x = width - 1; x >= 0; x--) {
      run = alpha[rowStart + x] === 0 ? (run < 65535 ? run + 1 : 65535) : 0;
      rowFree[rowStart + x] = run;
    }
  }
  // Сканер з кроком 4 для швидкості — у нас 8K+ гліфів, точність до пікселя
  // не потрібна (PAD=2 покриває).
  let foundX = -1, foundY = -1;
  outer: for (let y = height - needH; y >= 0; y -= 4) {
    for (let x = 0; x <= width - needW; x += 4) {
      let ok = true;
      for (let dy = 0; dy < needH; dy++) {
        if (rowFree[(y + dy) * width + x] < needW) { ok = false; break; }
      }
      if (ok) { foundX = x; foundY = y; break outer; }
    }
  }
  // Повертаємо alpha buffer назад через transfer — щоб caller міг переюзати.
  (self as unknown as Worker).postMessage(
    { x: foundX, y: foundY, alpha },
    { transfer: [alpha.buffer] }
  );
});
