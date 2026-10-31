import { Button, Checkbox, Modal, Radio } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState } from "react";
import { isTauriRuntime } from "../repository";
import {
  loadCloseBehavior,
  saveCloseBehavior,
  type CloseAction,
} from "../window/closeBehavior";

interface CloseConfirmDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 点击标题栏 X（或 Alt+F4）时的关闭确认：Rust 端拦截 CloseRequested 后发
 * `window:close-requested` 事件。这里提供两个选项（最小化到后台 / 退出应用），
 * 勾选「下次不再询问」后按该选择直接执行；标题栏透明度设置区可随时改回。
 */
export function CloseConfirmDialog({ open, onClose }: CloseConfirmDialogProps) {
  // 弹窗默认选中上次记住的行为（若有），否则默认最小化到后台
  const remembered = loadCloseBehavior();
  const [action, setAction] = useState<CloseAction>(
    remembered?.action ?? "hide",
  );
  const [remember, setRemember] = useState(true);

  const confirm = () => {
    if (remember) saveCloseBehavior({ action, remember: true });
    // 先关弹窗：隐藏窗口后弹窗仍处于挂载状态，不关闭会在下次显示窗口时残留
    onClose();
    if (!isTauriRuntime()) return;
    if (action === "quit") {
      void invoke("quit_app");
    } else {
      void getCurrentWindow().hide();
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="要关闭便签吗？"
      centered
      closable
      mask={{ closable: false }}
      footer={[
        <Button key="cancel" onClick={onClose}>
          取消
        </Button>,
        <Button key="ok" type="primary" onClick={confirm}>
          确定
        </Button>,
      ]}
    >
      <div className="close-confirm-options">
        <label className="close-confirm-option">
          <Radio
            checked={action === "hide"}
            onChange={() => setAction("hide")}
          />
          <span className="close-confirm-option-label">最小化到后台</span>
          <span className="close-confirm-option-desc">
            隐藏窗口，托盘常驻继续接收提醒
          </span>
        </label>
        <label className="close-confirm-option">
          <Radio
            checked={action === "quit"}
            onChange={() => setAction("quit")}
          />
          <span className="close-confirm-option-label">退出应用</span>
          <span className="close-confirm-option-desc">结束进程，不再提醒</span>
        </label>
      </div>
      <div className="close-confirm-remember">
        <Checkbox
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        >
          下次不再询问，始终执行以上选择
        </Checkbox>
        <span className="close-confirm-hint">
          可在标题栏「背景透明度」设置中修改
        </span>
      </div>
    </Modal>
  );
}
