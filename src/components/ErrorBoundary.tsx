import { Component, type ReactNode } from "react";
import { t } from "../lib/i18n";

interface Props {
  children: ReactNode;
  label?: string;
}
interface State {
  error: Error | null;
  info?: { componentStack?: string };
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    console.error("[ErrorBoundary] caught:", error, info);
    this.setState({ error, info });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-6 max-w-[820px] mx-auto">
          <div className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-4">
            <p className="text-[13px] font-bold text-[var(--danger)] mb-2">
              UI crash{this.props.label ? ` — ${this.props.label}` : ""}
            </p>
            <p className="text-[12.5px] text-[var(--text)] mb-2 whitespace-pre-wrap break-words">
              {this.state.error.message}
            </p>
            {this.state.error.stack && (
              <pre className="text-[10.5px] font-mono text-[var(--text-faint)] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded p-2 max-h-[260px] overflow-y-auto whitespace-pre-wrap break-all">
                {this.state.error.stack}
              </pre>
            )}
            {this.state.info?.componentStack && (
              <details className="mt-2">
                <summary className="text-[11px] text-[var(--text-muted)] cursor-pointer">Component stack</summary>
                <pre className="mt-2 text-[10.5px] font-mono text-[var(--text-faint)] bg-[var(--bg-surface)] border border-[var(--border-soft)] rounded p-2 max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all">
                  {this.state.info.componentStack}
                </pre>
              </details>
            )}
            <div className="mt-3 flex gap-2">
              <button
                className="dp-btn dp-btn--primary"
                onClick={() => this.setState({ error: null, info: undefined })}
              >
                {t("components.errorBoundary.retry")}
              </button>
              <button
                className="dp-btn"
                onClick={() => window.location.reload()}
              >
                {t("components.errorBoundary.reload")}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
