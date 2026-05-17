import { useT } from "../i18n";

export default function Billing() {
  const t = useT();
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">{t("billing.title")}</h1>
      <div className="bg-white rounded shadow p-6">
        <p className="text-slate-600">
          {t("nav.billing")} — coming soon.
        </p>
      </div>
    </div>
  );
}
