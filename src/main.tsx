import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadExternalLocales } from "./lib/i18n";
import "./styles/global.css";

// Fire-and-forget: підвантажуємо зовнішні locale-файли (якщо вони є). Не
// блокуємо рендер — якщо файлів немає, додаток працює зі вбудованим словником.
loadExternalLocales().catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
