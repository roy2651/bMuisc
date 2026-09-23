// 弹窗 Esc 关闭的统一栈：多个弹窗叠加时（如更新提示盖在解析弹窗上），
// Esc 只关最上层，避免一个按键把所有弹窗连同用户数据一起关掉。
// 各弹窗通过 useEffect 注册 / 注销，先进后出；输入法选词的 Esc（isComposing）
// 不触发关闭，与各弹窗原有的按键过滤一致。
type OnEsc = () => void;

const stack: OnEsc[] = [];

window.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (top) top();
});

/** 注册当前弹窗的 Esc 处理，返回注销函数（useEffect cleanup 用） */
export function registerEsc(onEsc: OnEsc): () => void {
  stack.push(onEsc);
  return () => {
    const i = stack.indexOf(onEsc);
    if (i >= 0) stack.splice(i, 1);
  };
}
