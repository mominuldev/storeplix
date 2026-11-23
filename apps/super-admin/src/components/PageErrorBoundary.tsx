import { Card } from '@storeplix/ui';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './States';

// A render error on one page must not blank the whole console (sidebar, search, sign-out): show the Figma error
// state 148:35336 in the content area instead. AppShell keys it on the path, so navigating away resets it.
export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <Card>
          <ErrorState title="This page couldn’t be shown" onRetry={() => this.setState({ error: null })} />
        </Card>
      );
    }
    return this.props.children;
  }
}
