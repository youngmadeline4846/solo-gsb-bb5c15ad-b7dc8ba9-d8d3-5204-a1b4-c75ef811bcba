import { useCallback, useState } from 'react';

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

/**
 * 可撤销 / 重做的状态容器。
 * set() 提交一个新版本（清空重做栈）；undo()/redo() 在历史中移动。
 */
export function useUndoable<T>(initial: T) {
  const [history, setHistory] = useState<History<T>>({
    past: [],
    present: initial,
    future: [],
  });

  const set = useCallback((next: T) => {
    setHistory((h) => ({ past: [...h.past, h.present], present: next, future: [] }));
  }, []);

  const undo = useCallback(() => {
    setHistory((h) =>
      h.past.length === 0
        ? h
        : {
            past: h.past.slice(0, -1),
            present: h.past[h.past.length - 1],
            future: [h.present, ...h.future],
          },
    );
  }, []);

  const redo = useCallback(() => {
    setHistory((h) =>
      h.future.length === 0
        ? h
        : {
            past: [...h.past, h.present],
            present: h.future[0],
            future: h.future.slice(1),
          },
    );
  }, []);

  const reset = useCallback((value: T) => {
    setHistory({ past: [], present: value, future: [] });
  }, []);

  return {
    value: history.present,
    set,
    undo,
    redo,
    reset,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
