// 弹窗焦点管理：打开时把焦点移入弹窗并聚焦容器（防止背景输入框继续吃键盘——
// 实测更新弹窗盖着链接输入框时按 Enter 仍会解析背后的链接），Tab 循环限制在
// 弹窗内部，关闭时把焦点还给打开前的元素。鼠标点击背景本就被遮罩拦截，
// 无需 inert。焦点还原让被自动弹窗打断的输入可以直接继续。
import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

// 多弹窗叠加时（如设置弹窗上再弹更新提示），只有最上层（最后注册）的弹窗
// 处理 Tab，下层直接跳过——否则下层的「焦点不在自己容器内」分支会把焦点
// 抢回自己，与上层陷阱互相拉扯。与 escStack 同一套进栈/出栈约定。
const trapStack: object[] = [];

export function useModalFocus(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const token = {};
    trapStack.push(token);
    const prev = document.activeElement as HTMLElement | null;
    // 容器内已有焦点（input autoFocus 先于 effect 生效）时不抢：聚焦输入框优先
    if (!el.contains(document.activeElement)) el.focus();
    // capture 挂 window：无论焦点此刻在哪（弹窗内/外），Tab 都先经过这里
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (trapStack[trapStack.length - 1] !== token) return; // 上层还有别的弹窗
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0] ?? el;
      const last = items[items.length - 1] ?? el;
      const active = document.activeElement;
      if (!(active instanceof Node) || !el.contains(active)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey) {
        if (active === first || active === el) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || active === el) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const i = trapStack.indexOf(token);
      // 仅顶层弹窗卸载才还原焦点：下层弹窗先卸载时（如设置里手动检查返回后
      // 关闭设置，而更新弹窗仍开着），还原会把焦点送回背景输入框，上层弹窗
      // 不会重新接管——按键又会穿透到背景（已复现）。
      // prev 已随下层弹窗卸载（isConnected=false）时 focus() 是静默 no-op，
      // 焦点落 body——无穿透风险，不强求
      const wasTop = i === trapStack.length - 1;
      if (i >= 0) trapStack.splice(i, 1);
      if (wasTop && prev?.isConnected) prev.focus();
    };
    // 仅挂载时接管一次；容器 ref 在弹窗生命周期内不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
