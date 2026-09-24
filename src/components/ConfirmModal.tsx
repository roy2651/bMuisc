// 通用确认弹窗：所有删除/清除类操作统一走这里（Esc、点遮罩 = 取消）。
// 危险操作用红色确认键；body 支持多行说明（级联范围、影响面）。
import { useEffect, useRef } from 'react';
import { registerEsc } from '../escStack';
import { useModalFocus } from '../useModalFocus';
import { IconX } from './icons';

interface Props {
  title: string;
  body: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmModal({ title, body, confirmText = '确定', danger, onConfirm, onClose }: Props) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => registerEsc(() => onCloseRef.current()), []);
  // 焦点接管：Tab 限制在本弹窗内（栈约定保证多层弹窗只有最上层吃 Tab）；
  // 默认聚焦容器而非确认键，危险操作不因误按 Enter 直接触发
  useModalFocus(ref);

  return (
    // stopPropagation：确认弹窗可能嵌在其他弹窗内（如同步弹窗），点遮罩只关自己，
    // 不能把底层弹窗的 mask onClick 一并触发
    <div
      className="modal-mask confirm-mask"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="modal confirm-modal" tabIndex={-1} ref={ref} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="关闭">
          <IconX />
        </button>
        <h3 className="confirm-title">{title}</h3>
        <p className="confirm-body">{body}</p>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            className={`btn${danger ? ' danger' : ' accent'}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
