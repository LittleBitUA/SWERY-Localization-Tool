import { formatDuration, useMetrics } from "../lib/metrics";
import { useT } from "../lib/i18n";

export function MetricsBadge() {
  const t = useT();
  const { session, today } = useMetrics();
  const duration = formatDuration(Date.now() - session.startedAt);
  return (
    <span title={t("metrics.tooltip")}>
      📊 {t("metrics.session")}: <span className="text-[var(--text)] font-semibold">{session.rows}</span>r{" "}
      <span className="text-[var(--text)] font-semibold">{session.words}</span>w · {duration}
      {today.rows > 0 && (
        <>
          {" · "}
          {t("metrics.today")}:{" "}
          <span className="text-[var(--accent)] font-semibold">{today.rows}</span>r
        </>
      )}
    </span>
  );
}
