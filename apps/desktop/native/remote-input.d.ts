// jw_remote_input 애드온 타입(src/remote_input.cpp 정본).
export interface RemoteInputAddon {
  supported(): boolean;
  virtualScreen(): { x: number; y: number; w: number; h: number };
  mouseMove(x: number, y: number): boolean;
  mouseButton(button: 0 | 1 | 2, down: boolean): boolean;
  wheel(dx: number, dy: number): boolean;
  key(scancode: number, extended: boolean, down: boolean): boolean;
  secureDesktop(): boolean;
}
export function load(): RemoteInputAddon | null;
