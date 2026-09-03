import { Component, type ErrorInfo, type ReactNode } from "react";
import { Sentry } from "../sentry";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
    Sentry.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div style={{ padding: 32, textAlign: "center" }}>
            <h2>Something went wrong</h2>
            <pre style={{ color: "red", whiteSpace: "pre-wrap" }}>{this.state.error.message}</pre>
            <button onClick={() => window.location.reload()}>Reload page</button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
