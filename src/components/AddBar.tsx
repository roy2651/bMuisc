// 顶部链接输入与解析入口

import { useState } from 'react';
import { extractBvid, resolveView, type ViewInfo } from '../api';

interface Props {
  input: string;
  onInput: (v: string) => void;
  onParsed: (view: ViewInfo) => void;
}

export default function AddBar({ input, onInput, onParsed }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="addbar-wrap">
      <div className={`addbar${busy ? ' busy' : ''}`}>
        <input
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
