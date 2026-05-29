declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionUIContext {
    custom<T>(renderer: (...args: any[]) => any, opts?: any): Promise<T | undefined>;
    select?(question: string, items: string[]): Promise<string>;
    confirm?(title: string, message: string, opts?: any): Promise<boolean>;
    input?(title: string, message: string, opts?: any): Promise<string>;
    notify(message: string, level?: string): void;
    setStatus?(id: string, text: string | undefined): void;
    setWidget?(key: string, content: any, opts?: any): void;
    setWorkingMessage?(message?: string): void;
    setWorkingIndicator?(opts?: any): void;
    [key: string]: any;
  }
  export interface ExtensionAPI {
    ui?: any;
    exec?: (...args: any[]) => any;
    registerCommand?: (...args: any[]) => any;
    registerMessageRenderer?: (...args: any[]) => any;
    registerRoute?: (...args: any[]) => any;
    sendMessage?: (...args: any[]) => any;
    sendUserMessage?: (...args: any[]) => any;
    events?: { on(event: string, handler: (...args: any[]) => void): void; emit(event: string, data?: any): void };
    [key: string]: any;
  }
  export interface ExtensionCommandContext {
    args?: string;
    cwd?: string;
    hasUI?: boolean;
    ui?: ExtensionUIContext;
    waitForIdle?(): Promise<void>;
    [key: string]: any;
  }
}

declare module "@mariozechner/pi-tui" {
  export interface Component {
    render?(width: number, height?: number): string[];
    handleInput?(data: string): Promise<boolean> | boolean;
    cursor?(): { x: number; y: number } | null;
    dispose?(): void;
  }
  export interface Theme {
    fg(category: string, text: string): string;
    bg(category: string, text: string): string;
    bold(text: string): string;
    italic(text: string): string;
    strikethrough(text: string): string;
  }
  export type OverlayAnchor =
    | "center" | "top-left" | "top-right"
    | "bottom-left" | "bottom-right"
    | "top-center" | "bottom-center"
    | "left-center" | "right-center";
  export interface OverlayMargin {
    top?: number; right?: number; bottom?: number; left?: number;
  }
  export type SizeValue = number | `${number}%`;
  export interface OverlayOptions {
    width?: SizeValue;
    minWidth?: number;
    maxHeight?: SizeValue;
    anchor?: OverlayAnchor;
    offsetX?: number;
    offsetY?: number;
    row?: SizeValue;
    col?: SizeValue;
    margin?: OverlayMargin | number;
    visible?: (termWidth: number, termHeight: number) => boolean;
    nonCapturing?: boolean;
  }
  export interface OverlayHandle {
    hide(): void;
    setHidden(hidden: boolean): void;
    isHidden(): boolean;
    focus(): void;
    unfocus(): void;
    isFocused(): boolean;
  }
  export interface TUI {
    showOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
    requestRender(): void;
    readonly width: number;
    readonly height: number;
  }
  export class Container {
    addChild(...args: any[]): void;
    removeChild(...args: any[]): void;
    render(width: number): string[];
    invalidate(): void;
  }
  export class Spacer {
    constructor(height?: number);
  }
  export class Text {
    constructor(text?: string, paddingX?: number, paddingY?: number, bgFn?: (s: string) => string);
    setText(text: string): void;
  }
  export class Markdown {
    constructor(text?: string, paddingX?: number, paddingY?: number, theme?: any);
    setText(text: string): void;
  }
  export function truncateToWidth(value: string, width: number): string;
  export function visibleWidth(value: string): number;
  export function wrapTextWithAnsi(text: string, width: number): string[];
  export interface SelectItem {
    value: string;
    label: string;
    description?: string;
  }
  export interface SelectListTheme {
    selectedPrefix?: (text: string) => string;
    selectedText?: (text: string) => string;
    description?: (text: string) => string;
    scrollInfo?: (text: string) => string;
    noMatch?: (text: string) => string;
  }
  export class SelectList {
    constructor(
      items: SelectItem[],
      maxHeight: number,
      theme?: SelectListTheme,
    );
    onSelect: (item: SelectItem) => void;
    onCancel: () => void;
    handleInput(data: string): void;
    render(width: number): string[];
  }
  export class DynamicBorder {
    constructor(borderFn: (s: string) => string);
  }
}
