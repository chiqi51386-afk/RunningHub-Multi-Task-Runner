type FocusWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

/** A second launch may arrive after the window closed but before shutdown finished. */
export function focusExistingWindow(window: FocusWindow | undefined, quitting: boolean): void {
  if (quitting || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
