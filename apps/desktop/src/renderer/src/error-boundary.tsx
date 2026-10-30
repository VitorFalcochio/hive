import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Last resort for a render error: say what broke and offer a reload, instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info);
  }
  override render() {
    return this.state.error ? (
      <main>
        <h1>Não foi possível carregar a interface</h1>
        <p role="alert">{this.state.error}</p>
        <button onClick={() => location.reload()}>Recarregar</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
