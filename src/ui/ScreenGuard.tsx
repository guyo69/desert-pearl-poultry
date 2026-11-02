// Keeps one screen's error from blanking the whole app. If a screen fails to
// draw (for example a browser feature missing on an older phone), the person
// sees what went wrong and can switch screens or reload, and the message can
// be read out or photographed for support.
import { Component, type ReactNode } from 'react';

interface Props { name: string; children: ReactNode }
interface State { error: Error | null }

export class ScreenGuard extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error) { console.error(`Screen "${this.props.name}" failed`, error); }
  componentDidUpdate(prev: Props) { if (prev.name !== this.props.name && this.state.error) this.setState({ error: null }); }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return <div className="card" role="alert" style={{ padding: 20 }}>
      <h3 style={{ margin: '0 0 6px' }}>This screen could not open</h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 14 }}>The other screens still work. Please send a photo of this message to support.</p>
      <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5, background: 'var(--inset)', padding: 10, borderRadius: 10, wordBreak: 'break-word', margin: '0 0 12px' }}>
        {this.props.name}: {e.name}: {e.message}<br />{navigator.userAgent}</p>
      <button className="btn sm" onClick={() => location.reload()}>Reload the app</button>
    </div>;
  }
}
