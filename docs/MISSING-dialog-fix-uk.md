# THE MISSING: як ми зробили щоб діалоги влазили і не переносилися посеред слова

Коротко для друга. Це не модінг-нотатки (вони в [`THE-MISSING-modding-notes.txt`](THE-MISSING-modding-notes.txt) і англійською). Це **історія розв'язання**: що було, що я перепробував, що зрештою спрацювало і як цим користуватися.

---

## Симптоми

Коли я почав українізувати THE MISSING, у чат-діалогах Емілі (фоновий месенджер) текст обрізався або переносився посеред слова:

| Проблема | Приклад на скріні |
|---|---|
| Хвіст слова обрізається | «Хочу покататися на тук-**ту**» (треба «тук-туку») |
| Cha-char wrap | «не **пот** / **ребувала**» (треба «не / потребувала») |
| Сухі обрізання | «Це Джей-**Д**», «Додай **м**», «Мій день народження **аж н**» |

Текст влазить ідеально англійською (`I want to ride a tuk-tuk`, `OK`, `I'm fine`), але UA довша на 20-40%, і гра не була написана з розрахунком на це.

---

## Що НЕ спрацювало (і чому варто було спочатку перевірити)

Перш ніж знайти справжню причину, я пробував **3 різних шляхи**, які виглядали логічно — і всі ВПРОВАДЖЕНІ і ПЕРЕВІРЕНІ у грі. Усі дали 0 ефекту. Ось чому це повчально:

### 1. ❌ Знизити поріг `FixedBallon.SetText` (100 → 0)

У DLL знайшов клас `TheMISSING.UI.FixedBallon` — діалоговий пухир. Він обирає один з 3-х prefab'ів (Small/Medium/Large) за порогом `PreferredWidth > 100 px`. Я подумав: знизимо до 0 → всі однолінійні репліки отримають Medium замість Small → ширше → влізе.

**Чому не спрацювало**: `FixedBallon` — це НЕ той клас. Він використовується для «overhead dialogue» (репліки над персонажами у грі). А чат-месенджер (де UA обрізалася) використовує **інший клас** — `TheMISSING.UI.Ballon` (без `Fixed-`). Я місяць шукав не там.

### 2. ❌ Перемикнути всі pухирі на Large

Думав: може Large prefab ширший за Medium. Замінив у IL всі `stfld typeSize` на `ldc.i4.0` (= Large).

**Чому не спрацювало**: і знову не той клас. Плюс — навіть якби це був правильний клас — Small/Medium/Large у MISSING-prefab'і **відрізняються тільки висотою**, не шириною. Зайвий висновок: не вгадуй за іменем, дивись prefab розміри.

### 3. ❌ Перемкнути `UI.Text.VerticalOverflow` з `Truncate` на `Overflow` у 754 компонентах

Знайшов що 754 з 754 Unity-UI.Text компонентів мають `VerticalOverflow = Truncate (0)`. Логічно: текст переноситься на наступний рядок, але якщо вертикалі не вистачає — обрізається. Запатчив `m_FontData.m_VerticalOverflow = 1 (Overflow)` у 5 sharedassets-файлах (resources + 4 levels).

**Чому не спрацювало**: чат-месенджер взагалі **не використовує** Unity-стандартний `UI.Text` wrap. Він йде через **кастомний** клас `TheMISSING.UI.TextExGenerator` (своя реалізація layout-у з японською типографікою). Зміни до стандартного `UI.Text` його не зачіпають.

### 4. ❌ Повний rewrite `TextExSettings.CheckWordWrap` через Mono.Cecil

Найбільш ризикований. Спробував переписати тіло методу нуль-у-нуль через `m.Body.Instructions.Clear() + ilp.Emit()`. Логіка: «дозволяй wrap тільки на whitespace».

**Чому не спрацювало**: Unity відмовився завантажувати модифікований метод — у грі **порожні** pухирі без тексту взагалі. Multi-branch Mono.Cecil rewrite з locals — дуже крихкий. Простий simple-getter rewrite — працює, а ось більш складний з try/catch — ні.

---

## Що спрацювало

Три IL-патчі через **Mono.Cecil** прямо у `Assembly-CSharp.dll`. Виконуються одним кліком у UI tool-у. Сумарно `.dll.bak` створюється один раз; кожна правка змінює 2-6 байт IL.

### Патч 1 + 2: `Ballon.CheckProperties` + `BallonController.CheckProperties`

**Проблема**: `TheMISSING.UI.Ballon` (правильний клас для чат-bubble) розпізнає 3 режими розміру через enum:

```csharp
enum TypeSizeControl {
    UseWidthAndHeightPixcels = 0,  // ширина = поле Width (default 128 px)
    UseCharAndLineCounts     = 1,  // ширина = m_CharacterCount × fontSize
    UseTextInfo              = 2   // ширина = TextExGenerator.PreferredWidth + 2
}
```

У prefab'ах MISSING серіалізовано **0** (фіксована ширина 128 px) або **1** (фіксована кількість символів — наприклад 50). UA-текст з 25+ символів зменшується до 128 px, не вміщується, ріжеться маскою.

**Що ми зробили**: примусово підміняємо в IL значення `SizeControlType` на `2 (UseTextInfo)`:

```
ДО:                                ПІСЛЯ:
IL_0000: ldarg.0                   IL_0000: nop
IL_0001: ldfld SizeControlType     IL_0001: ldc.i4.2
IL_0006: stloc.0                   IL_0006: stloc.0   (без змін)
```

Тобто локальна змінна `V_0 = this.SizeControlType` замінюється на `V_0 = 2`. **Серіалізоване поле НЕ чіпаємо** — лише runtime-switch.

Робимо це для обох класів: `Ballon` (in-game chat) і `BallonController` (HUD-pухири). Тепер `CheckProperties()` йде в гілку case 2 → ширина береться з `TextExGenerator.PreferredWidth + 2`, тобто адаптується під фактичну ширину тексту.

**Ефект у грі**: `Хочу покататися на тук-туку.` — повне слово видно, pухир розширився.

### Патч 3: `TextExGenerator.get_WordWrapType` → завжди `Default (1)`

**Проблема**: навіть після патчів 1+2 текст усе ще розривається посеред слова: `не пот / ребувала`. Це окрема проблема — `WordWrap` логіка `TextExGenerator` (кастомний layout):

```csharp
enum WordWrap {
    Default            = 1,  // bit0: дозволяти на whitespace
    JapaneseProhibits  = 2   // bit1: японська пунктуація
}
```

У prefab чат-bubble `wordWrap` серіалізовано як **0 (None)**. Тоді `CheckWordWrap()` завжди повертає `false` → `GetAutoLineBreakIndex()` як fallback бере `index - 1` (одна позиція назад від overflow) — **character wrap**. Кожен char вважається валідним wrap-point.

**Що ми зробили**: getter методу переписали нуль-у-нуль на простий `ldc.i4.1; ret`:

```
ДО:                                              ПІСЛЯ:
IL_0000: ldarg.0                                 IL_0000: ldc.i4.1
IL_0001: ldfld TextExGenerator::wordWrap         IL_0001: ret
IL_0006: ret                                     (2 інструкції)
```

Це **простий-геттер rewrite** — Mono.Cecil таке робить надійно (на відміну від rewrite-у multi-branch методу). Тепер getter завжди повертає `1`, незалежно від серіалізованого field.

З bit0=1 логіка `CheckWordWrap`:
- На whitespace pair → `false` (бо `V_1 = JapaneseProhibits` теж 0, і код повертає false якщо обидва біти 0 на whitespace).
- Між не-separator chars → `true`.

`ParseWordWrap` йде назад поки `true` (= між літерами), на whitespace зупиняється і повертає `index - 1` (= позицію перед пробілом). **Результат**: wrap на пробілі між словами.

**Ефект у грі**: `Я поруч, коли б ти мене не / потребувала.` — `потребувала` лишається цілим, перенос на пробілі перед.

---

## Як цим користуватися (для друга який почне перекладати)

1. **Завантаж** [SweryLocalizationTool-1.0.8-portable.exe](https://github.com/LittleBitUA/SWERY-Localization-Tool/releases/latest).
2. Запусти. Перший раз попросить шлях до гри (Steam → THE MISSING).
3. На головному екрані обери **THE MISSING** → **Текст**.
4. У header'і редактора шукай кнопку **🪄 Виправити діалоги** (поряд із Pack/DLL). 
5. Натискаєш → підтверджуєш → програма пише `Assembly-CSharp.dll.bak`, виконує 3 IL-патчі, готово (~1 с).
6. **Перезапусти TheMISSING.exe** (Unity не перечитує DLL на льоту). Більше нічого робити не треба.

Кнопка «✓ Діалоги» (зеленим) означає що патч уже застосований. Жовтенький banner внизу хедера зникне.

Якщо щось не сподобалось — **↺ Відкотити** у тій самій DLL-модалці поверне DLL з `.dll.bak`. Гра знов потребує перезапуску.

---

## Чи треба ще використовувати Auto-fit box-sizes?

**Майже точно ні.** Auto-fit редагує `IMHeightInfo.bin` (per-msgEnum W×H). Жоден з трьох пухирів (`Ballon`, `BallonController`, `FixedBallon`) **не читає** `IMHeightInfo`. Цей файл керує якоюсь іншою UI-системою (можливо титри або loading screens — точно не з'ясовував).

Якщо побачиш обрізання у НЕ-чат UI (титри, інвентар) — спробуй Auto-fit. У 99% перекладу його використовувати не доведеться.

---

## TL;DR

1. Спочатку Bidlov пробував FixedBallon, Large bubble, UI.Text overflow, full Cecil rewrite — **усе не спрацювало** (не той клас, або занадто крихкий rewrite).
2. Справжній клас чат-bubble — `Ballon` (без `Fixed-`).
3. Три патчі: `Ballon.CheckProperties` + `BallonController.CheckProperties` (форсимо `SizeControlType=UseTextInfo`) + `TextExGenerator.get_WordWrapType` getter rewrite (завжди `Default`).
4. Кнопка `🪄 Виправити діалоги` в редакторі MISSING-тексту robит це одним кліком. `.dll.bak` для відкату.
5. Auto-fit box-sizes — не для чату; забудь.

Для технічних деталей з offset'ами і IL-байтами — [`THE-MISSING-modding-notes.txt §10`](THE-MISSING-modding-notes.txt).
