import { Button, Modal, Progress, Select } from "antd";
import {
  CheckOutlined,
  PauseOutlined,
  PlayCircleOutlined,
  RedoOutlined,
} from "@ant-design/icons";
import { useEffect } from "react";
import {
  BREAK_PRESETS,
  fmt,
  MODE_LABEL,
  WORK_PRESETS,
  type PomodoroControls,
  type PomodoroState,
} from "../utils/pomodoro";

interface PomodoroDialogProps {
  open: boolean;
  onClose: () => void;
  state: PomodoroState;
  controls: PomodoroControls;
  workMinutes: number;
  breakMinutes: number;
}

/** 番茄钟弹窗：专注/休息倒计时 + 轮次计数，计时器本身由标题栏常驻（关闭弹窗仍在走） */
export function PomodoroDialog({
  open,
  onClose,
  state,
  controls,
  workMinutes,
  breakMinutes,
}: PomodoroDialogProps) {
  const { mode, remainingMs, running, rounds } = state;
  const totalMs = (mode === "work" ? workMinutes : breakMinutes) * 60_000;
  const percent = Math.min(100, Math.max(0, 100 - (remainingMs / totalMs) * 100));

  // 弹窗打开时切到当前模式对应预设
  useEffect(() => {
    if (!open) return;
    controls.setMode(mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="番茄钟"
      centered
      footer={null}
      width={330}
    >
      <div className="pomodoro-body">
        <div className="pomodoro-ring">
          <Progress
            type="circle"
            percent={Math.round(percent)}
            size={168}
            strokeColor={mode === "work" ? "#d9686b" : "#57a878"}
            trailColor="rgba(128,128,128,0.18)"
            format={() => <span className="pomodoro-time">{fmt(remainingMs)}</span>}
          />
        </div>
        <div className="pomodoro-meta">
          <span className={`pomodoro-mode ${mode}`}>
            {MODE_LABEL[mode]}
          </span>
          <span className="pomodoro-rounds">第 {rounds + 1} 轮</span>
        </div>

        <div className="pomodoro-controls">
          {running ? (
            <Button
              icon={<PauseOutlined />}
              onClick={controls.pause}
            >
              暂停
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={controls.start}
            >
              {remainingMs <= 0 ? "开始" : "继续"}
            </Button>
          )}
          <Button icon={<RedoOutlined />} onClick={controls.reset}>
            重置
          </Button>
          {remainingMs <= 0 && !running && (
            <Button
              icon={<CheckOutlined />}
              onClick={() => {
                controls.reset();
                controls.start();
              }}
            >
              再来一轮
            </Button>
          )}
        </div>

        <div className="pomodoro-settings">
          <div className="pomodoro-setting">
            <span>专注</span>
            <Select
              size="small"
              value={workMinutes}
              onChange={(value) => controls.setWorkMinutes(value)}
              options={WORK_PRESETS.map((minutes) => ({
                value: minutes,
                label: `${minutes} 分钟`,
              }))}
            />
          </div>
          <div className="pomodoro-setting">
            <span>休息</span>
            <Select
              size="small"
              value={breakMinutes}
              onChange={(value) => controls.setBreakMinutes(value)}
              options={BREAK_PRESETS.map((minutes) => ({
                value: minutes,
                label: `${minutes} 分钟`,
              }))}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
