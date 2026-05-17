import { createRoot } from "react-dom/client";
import App from "./App";
import { I18nProvider } from "../i18n";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <I18nProvider>
    <App />
  </I18nProvider>,
);
