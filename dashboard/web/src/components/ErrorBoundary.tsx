import { Component, type ErrorInfo, type ReactNode } from "react"

// A render error must never leave a blank window: show what failed so it can be reported.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Bot Dashboard render error:", error, info.componentStack) }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-10">
        <h1 className="text-xl font-semibold">Something went wrong drawing this page</h1>
        <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs whitespace-pre-wrap">{error.stack || error.message}</pre>
        <div className="flex gap-3">
          <button className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted" onClick={() => { location.hash = "#/"; location.reload() }}>Reload</button>
        </div>
      </div>
    )
  }
}
