import { Component, type ReactNode } from "react";

export class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="app-error-boundary" role="alert"><h1>界面暂时无法显示</h1><p>后台任务不受此界面提示控制。请重新打开应用；尚未保存的输入可能需要重新填写。</p><button className="primary" onClick={() => window.location.reload()}>重新加载界面</button></main>;
    return this.props.children;
  }
}
