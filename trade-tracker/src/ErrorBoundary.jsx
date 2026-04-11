// src/ErrorBoundary.jsx
// Catches React render crashes and shows a readable error panel
// instead of a blank white screen. Wraps individual views so a crash
// in one panel never takes down the whole app.
import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // Log to startup log via backend if available
    try {
      fetch('http://127.0.0.1:3002/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          component: this.props.name || 'unknown',
          error:     error?.message || String(error),
          stack:     error?.stack?.slice(0, 800) || '',
          component_stack: info?.componentStack?.slice(0, 400) || '',
        }),
      }).catch(() => {});
    } catch {}
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    const { error, info } = this.state;
    const name = this.props.name || 'this panel';

    return (
      <div style={{
        margin: 20, padding: 24,
        background: '#fdf0ee', border: '1px solid #f0c4be',
        borderRadius: 10, fontFamily: 'Arial, sans-serif',
      }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: '#c0392b', marginBottom: 8 }}>
          ⚠ Something went wrong in {name}
        </div>
        <div style={{ fontSize: 13, color: '#444', marginBottom: 16 }}>
          The rest of the app is still working. You can switch to another tab and continue.
        </div>
        <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 6,
          padding: '10px 14px', fontSize: 12, fontFamily: 'monospace',
          color: '#c0392b', marginBottom: 12, maxHeight: 120, overflowY: 'auto' }}>
          {error?.message || String(error)}
        </div>
        {info?.componentStack && (
          <details style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
            <summary style={{ cursor: 'pointer', marginBottom: 4 }}>Component trace</summary>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 10 }}>
              {info.componentStack.slice(0, 600)}
            </pre>
          </details>
        )}
        <button
          onClick={() => this.setState({ hasError: false, error: null, info: null })}
          style={{ background: '#1a5fa8', color: '#fff', border: 'none', borderRadius: 6,
            padding: '7px 18px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          Try again
        </button>
        <span style={{ fontSize: 11, color: '#999', marginLeft: 12 }}>
          If this keeps happening, restart the app or switch to Demo Mode to isolate the issue.
        </span>
      </div>
    );
  }
}
