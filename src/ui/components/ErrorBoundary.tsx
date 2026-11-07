import { authHeaders } from '../api';
import { Component, type ReactNode } from 'react';

/**
 * Catches a screen that fails to draw, so one bad screen never blanks the whole app.
 * The books are safe: they live on the server, and nothing half-saved is written.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; onBack?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('Screen error', error, info.componentStack);
    fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message: error.message, stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 8000) }),
    }).catch(() => {});
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="form" style={{ maxWidth: 560 }}>
        <h2>This screen hit a problem</h2>
        <p className="hint">Nothing was lost: saved vouchers are safe, and an unsaved one was not written. The problem was noted in the error log.</p>
        <pre className="subtle" style={{ whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
        <div className="actions">
          {this.props.onBack && <button className="btn" onClick={() => { this.setState({ error: null }); this.props.onBack!(); }}>Go back (Esc)</button>}
          <button className="btn primary" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}
