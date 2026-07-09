import React from 'react';
import { AlertOctagon, RefreshCw } from 'lucide-react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("[AssetFlow ErrorBoundary] Unhandled runtime exception caught:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.hash = '#/dashboard';
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          backgroundColor: 'var(--bg-app, #0f0a1c)',
          color: 'var(--text-primary, #f1edfa)',
          fontFamily: 'var(--font-sans, system-ui, sans-serif)',
          padding: '24px',
          textAlign: 'center'
        }}>
          <div style={{
            maxWidth: '500px',
            padding: '40px 32px',
            borderRadius: '16px',
            backgroundColor: 'var(--bg-sidebar, #160f29)',
            border: '1px solid var(--border-color, #2d224d)',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
          }}>
            <AlertOctagon size={48} style={{ color: 'var(--status-disposed, #ef4444)', marginBottom: '20px' }} />
            <h1 style={{ fontSize: '22px', fontWeight: '700', margin: '0 0 12px' }}>Workspace Exception Encountered</h1>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary, #9c8eb9)', margin: '0 0 24px', lineHeight: '1.6' }}>
              The application encountered an unexpected runtime render crash. Any active edits have been preserved, and you can reload the dashboard to recover.
            </p>
            {this.state.error && (
              <div style={{
                textAlign: 'left',
                backgroundColor: '#090514',
                padding: '12px 16px',
                borderRadius: '8px',
                fontSize: '12px',
                fontFamily: 'var(--font-mono, monospace)',
                color: '#ff6b6b',
                overflowX: 'auto',
                marginBottom: '24px',
                borderLeft: '4px solid var(--status-disposed, #ef4444)'
              }}>
                <strong>Error:</strong> {this.state.error.message || String(this.state.error)}
              </div>
            )}
            <button 
              onClick={this.handleReset}
              className="btn btn-primary"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                margin: '0 auto'
              }}
            >
              <RefreshCw size={15} />
              Recover Workspace & Reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
