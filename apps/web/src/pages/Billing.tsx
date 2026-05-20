import { useT } from "../i18n";

export default function Billing() {
  const t = useT();
  return (
    <div className="page-fade">
      <div style={{ marginBottom: 32 }}>
        <div className="breadcrumb">
          {t("breadcrumb.organization")}
          <span className="breadcrumb-sep">/</span>
          {t("nav.billing")}
        </div>
        <h1 className="display-h1">{t("billing.title")}</h1>
        <p className="page-sub">{t("billing.subtitle")}</p>
      </div>
      <div className="empty-state surface-card">
        <h4>{t("billing.comingSoon")}</h4>
        <p>{t("billing.subtitle")}</p>
      </div>
    </div>
  );
}
