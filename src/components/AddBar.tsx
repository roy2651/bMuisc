// 顶部链接输入与解析入口；歌单页「添加音乐」会请求聚焦到这里
import { useEffect, useRef, useState } from 'react';
import { extractBvid, resolveView, type ViewInfo } from '../api';
import { usePlayer } from '../store';

interface Props {
  input: string;
  onInput: (v: string) => void;
  onParsed: (view: ViewInfo) => void;
  onFail?: () => void; // 解析失败回调（格式校验错不算）：清理一次性的目标提示
}

export default function AddBar({ input, onInput, onParsed, onFail }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusTick = usePlayer((s) => s.focusAddTick);
  useEffect(() => {
    if (focusTick > 0) inputRef.current?.focus();
  }, [focusTick]);

  async function go() {
    if (busy) return;
    setError(null);
    if (!extractBvid(input)) {
      setError('请粘贴 B 站视频链接或 BV 号');
      return;
    }
    setBusy(true);
    try {
      onParsed(await resolveView(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); // 解析失败保留输入内容，可直接改后重试
      onFail?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="addbar-wrap">
      <div className={`addbar${busy ? ' busy' : ''}`}>
        <input
          ref={inputRef}
          value={input}
          placeholder="粘贴 B 站链接或 BV 号，回车解析"
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void go()}
          spellCheck={false}
        />
        <button className="btn accent" onClick={() => void go()} disabled={busy}>
          {busy ? '解析中…' : '解析'}
        </button>
      </div>
      {error && <div className="addbar-error">{error}</div>}
    </div>
  );
}
