import { Component, type ReactNode } from "react";
import { useCopy } from "./copy.ts";

interface Props { children: ReactNode; scope: "thread" | "app" }
interface State { error: string | null; retried: boolean }

function Failure({ error, scope, retry, reload }: { error: string; scope: Props["scope"]; retry(): void; reload: boolean }) {
  const [copied, copy] = useCopy(error);
  return (
    <div className={scope === "thread" ? "tl" : "first"}>
      <div className="col">
        <p className="na render-error" role="alert">
          <span>{scope === "thread" ? "This conversation could not be shown." : "The app could not be shown."}</span>
          <button type="button" className="link" data-testid="ui.error.retry" onClick={reload ? () => window.location.reload() : retry}>{reload ? "Reload window" : "Try again"}</button>
          <button type="button" className="link" data-testid="ui.error.copy" onClick={copy}>{copied === true ? "Copied" : copied === false ? "Copy failed. Try again" : "Copy error"}</button>
        </p>
      </div>
    </div>
  );
}

/** Retry remounts the failed subtree; the external store keeps the unsent draft.
 * React's root reports each caught error once through its default console handler.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, retried: false };

  static getDerivedStateFromError(error: unknown): Pick<State, "error"> {
    return { error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }

  override render() {
    if (this.state.error !== null) return <Failure error={this.state.error} scope={this.props.scope} reload={this.props.scope === "app" && this.state.retried} retry={() => this.setState({ error: null, retried: true })} />;
    return this.props.children;
  }
}
