import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSession } from '@hive/core';
import { useHive } from './context';

// Colours follow the app's dark tokens, so the terminal does not look pasted in.
const theme = {
  background: '#0b0c0d',
  foreground: '#e6e7e8',
  cursor: '#4cd6a0',
  cursorAccent: '#0b0c0d',
  selectionBackground: 'rgba(110, 168, 254, 0.35)',
  black: '#1a1b1e',
  red: '#f87185',
  green: '#4cd6a0',
  yellow: '#f5b544',
  blue: '#6ea8fe',
  magenta: '#c4a1ff',
  cyan: '#5fd4e0',
  white: '#d4d6d9',
  brightBlack: '#62666d',
  brightRed: '#fb9aa8',
  brightGreen: '#7be3b9',
  brightYellow: '#f8cb75',
  brightBlue: '#9cc3ff',
  brightMagenta: '#d8c2ff',
  brightCyan: '#8ee3ec',
  brightWhite: '#f7f8f8',
};

/**
 * A live terminal for one session: it replays what was already printed, streams new output,
 * and sends what the user types (or pastes) to the process while it runs.
 */
export function TerminalView({
  session,
  clearSignal,
}: {
  session: TerminalSession;
  /** Changes whenever the user clears the output. */
  clearSignal: number;
}) {
  const { onTerminal } = useHive();
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // Read when the view mounts and on each keystroke, without rebuilding the terminal.
  const initialOutput = useRef(session.output);
  const running = useRef(session.status === 'running');
  running.current = session.status === 'running';

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const id = session.id;
    const terminal = new Terminal({
      fontFamily: "'JetBrains Mono Variable', Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5_000,
      theme,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminalRef.current = terminal;
    terminal.write(initialOutput.current);

    const sendSize = () => {
      // A collapsed panel has no size; fitting it would shrink the process to nothing.
      if (element.clientWidth < 40 || element.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      void window.hive
        .invoke('terminal.resize', { id, cols: terminal.cols, rows: terminal.rows })
        .catch(() => undefined);
    };
    sendSize();

    const typed = terminal.onData((data) => {
      if (!running.current) return;
      void window.hive.invoke('terminal.input', { id, data }).catch(() => undefined);
    });
    // Ctrl+C copies when text is selected (otherwise it interrupts, as usual); Ctrl+V pastes.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !(event.ctrlKey || event.metaKey)) return true;
      const key = event.key.toLowerCase();
      if (key === 'c' && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection()).catch(() => undefined);
        terminal.clearSelection();
        return false;
      }
      if (key === 'v') {
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (text) terminal.paste(text);
          })
          .catch(() => undefined);
        return false;
      }
      return true;
    });
    const stopOutput = onTerminal((event) => {
      if (event.type === 'output' && event.sessionId === id) terminal.write(event.chunk);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(sendSize, 80);
    });
    observer.observe(element);
    terminal.focus();

    return () => {
      stopOutput();
      typed.dispose();
      observer.disconnect();
      clearTimeout(timer);
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [session.id, onTerminal]);

  useEffect(() => {
    if (clearSignal) terminalRef.current?.clear();
  }, [clearSignal]);

  return (
    <div
      ref={host}
      className="xterm-host"
      aria-label={`Terminal: ${session.command || 'shell'}`}
      onMouseDown={() => terminalRef.current?.focus()}
    />
  );
}
