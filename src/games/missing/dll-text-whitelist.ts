// THE MISSING — Assembly-CSharp.dll user-facing string positions.
//
// 17 ldstr-позицій, які зустрічаються у грі як видимий UI-текст (меню
// якості графіки, мова, ON/OFF тригери). Решта 6500+ ldstr — це type-names,
// debug-strings, IDs, asset paths.
//
// Whitelist збудовано з UA-DLL Bidlov-а (попередній переклад MISSING) —
// усі позиції, де ldstr містив кириличні літери. На ОРИГІНАЛЬНІЙ англійській
// DLL ці ж позиції містять EN-варіанти ("Fantastic", "Beautiful", "ON", "OFF"
// тощо), тож whitelist спрацює і для нових перекладачів — їм буде показано
// саме ці 17 EN-рядків як кандидати на переклад.
//
// uaHint — приклад UA-перекладу (з Bidlov-а), використовується як автозаповнення
// у MissingDllEditor якщо поточна DLL ще не містить UA-варіанта.

export interface DllTextWhitelistEntry {
  type: string;
  method: string;
  offset: string;
  uaHint: string;
}

export const MISSING_DLL_TEXT_WHITELIST: DllTextWhitelistEntry[] = [
  { type: "TheMISSING.GameMainData.OptionData", method: ".cctor", offset: "0x0008", uaHint: "Фантастична" },
  { type: "TheMISSING.GameMainData.OptionData", method: ".cctor", offset: "0x0010", uaHint: "Прекрасна" },
  { type: "TheMISSING.GameMainData.OptionData", method: ".cctor", offset: "0x0018", uaHint: "Гарна" },
  { type: "TheMISSING.GameMainData.OptionData", method: ".cctor", offset: "0x0020", uaHint: "Проста" },
  { type: "TheMISSING.GameMainData.OptionData", method: ".cctor", offset: "0x0028", uaHint: "Швидка" },
  { type: "TheMISSING.GameMainData.OptionData", method: ".cctor", offset: "0x0030", uaHint: "Найшвидша" },
  { type: "TheMISSING.GameMainData.OptionData", method: ".cctor", offset: "0x00A8", uaHint: "Українська" },
  { type: "TheMISSING.Menu.Option.OptionBasis",  method: "AdaptVibration",    offset: "0x0037", uaHint: "УВІМК." },
  { type: "TheMISSING.Menu.Option.OptionBasis",  method: "AdaptVibration",    offset: "0x0041", uaHint: "ВИМК."  },
  { type: "TheMISSING.Menu.Option.OptionBasis",  method: "AdaptAntiAliasing", offset: "0x0037", uaHint: "УВІМК." },
  { type: "TheMISSING.Menu.Option.OptionBasis",  method: "AdaptAntiAliasing", offset: "0x0041", uaHint: "ВИМК."  },
  { type: "TheMISSING.Menu.Option.OptionBasis",  method: "AdaptFullScreen",   offset: "0x0037", uaHint: "УВІМК." },
  { type: "TheMISSING.Menu.Option.OptionBasis",  method: "AdaptFullScreen",   offset: "0x0041", uaHint: "ВИМК."  },
  { type: "TheMISSING.Menu.Title.OptionBasis",   method: "AdaptVibration",    offset: "0x0033", uaHint: "УВІМК." },
  { type: "TheMISSING.Menu.Title.OptionBasis",   method: "AdaptVibration",    offset: "0x003D", uaHint: "ВИМК."  },
  { type: "TheMISSING.Menu.Title.OptionBasis",   method: "AdaptFullScreen",   offset: "0x0033", uaHint: "УВІМК." },
  { type: "TheMISSING.Menu.Title.OptionBasis",   method: "AdaptFullScreen",   offset: "0x003D", uaHint: "ВИМК."  },
];

/** Швидкий lookup: чи позиція (type+method+offset) у whitelist. */
export function isInDllWhitelist(type: string, method: string, offset: string): boolean {
  return MISSING_DLL_TEXT_WHITELIST.some(
    (w) => w.type === type && w.method === method && w.offset === offset
  );
}

/** UA-hint для позиції (для автозаповнення placeholder-а у редакторі). */
export function getDllUaHint(type: string, method: string, offset: string): string | undefined {
  return MISSING_DLL_TEXT_WHITELIST.find(
    (w) => w.type === type && w.method === method && w.offset === offset
  )?.uaHint;
}
