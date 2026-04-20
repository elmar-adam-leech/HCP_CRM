import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[300px] p-8 text-center gap-4">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{this.props.fallbackTitle ?? "Something went wrong"}</h2>
            <p className="text-sm text-muted-foreground max-w-sm">
              An unexpected error occurred. Reloading the page will usually fix this.
            </p>
            {this.state.error && (
              <p className="text-xs text-muted-foreground font-mono mt-2 max-w-sm break-all">
                {this.state.error.message}
              </p>
            )}
          </div>
          <Button onClick={this.handleReload} variant="default">
            Reload page
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
