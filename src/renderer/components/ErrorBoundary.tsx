import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Root-level render-error guard for each window entry. Without it any throw
 * during render (e.g. an engine id this build doesn't know, synced from a
 * newer install) unmounts the whole tree and leaves a blank window with no
 * way out short of restarting the app.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; compact?: boolean },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] uncaught render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <ErrorFallback error={this.state.error} compact={this.props.compact} />
      );
    }
    return this.props.children;
  }
}

function ErrorFallback({
  error,
  compact = false
}: {
  error: Error;
  compact?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('common');
  return (
    <div
      role="alert"
      className={compact ? 'error-fallback error-fallback--compact' : 'error-fallback'}
    >
      <div className="error-fallback__title">{t('errorBoundary.title')}</div>
      {!compact && (
        <>
          <div className="error-fallback__desc">{t('errorBoundary.desc')}</div>
          <pre className="error-fallback__detail">{error.message}</pre>
        </>
      )}
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => window.location.reload()}
      >
        {t('errorBoundary.reload')}
      </button>
    </div>
  );
}
