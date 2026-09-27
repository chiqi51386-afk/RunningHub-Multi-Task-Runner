// Locally adapted neutral creative-workspace palettes, not official Adobe/Resolve colors.
// Keep IDs stable so existing saved preferences remain valid.
export const themes = [
  { id: "light", name: "专业亮色", colors: ["#e8e8e8", "#f5f5f5", "#245fba", "#414141"] },
  { id: "dark", name: "专业暗色", colors: ["#202020", "#292929", "#91baff", "#e6e6e6"] },
  { id: "eye", name: "柔和护眼", colors: ["#e7e4de", "#f1eee8", "#495d46", "#45433e"] },
  { id: "midnight", name: "深黑专注", colors: ["#141414", "#1d1d1d", "#a1c4ff", "#dedede"] },
] as const;
export type ThemeId = typeof themes[number]["id"];
export const validTheme = (value: unknown): ThemeId => themes.find(theme => theme.id === value)?.id ?? "dark";
