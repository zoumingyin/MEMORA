import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Popconfirm, Tooltip } from "antd";
import {
  ClearOutlined,
  DeleteOutlined,
  EditOutlined,
  UndoOutlined,
} from "@ant-design/icons";

/** 画布内部像素尺寸（固定，CSS 缩放显示；导出 PNG 保持清晰） */
const CANVAS_W = 1600;
const CANVAS_H = 1200;
/** 撤销栈上限 */
const HISTORY_LIMIT = 20;

/** 画笔颜色：深墨 / 白（暗色主题下的墨色）/ 分类主题色 */
const PEN_COLORS = [
  { value: "#1f2937", label: "深墨" },
  { value: "#ffffff", label: "白色" },
  { value: "#2563eb", label: "蓝色" },
  { value: "#d9686b", label: "红色" },
  { value: "#57a878", label: "绿色" },
  { value: "#f59e0b", label: "橙色" },
];

/** 笔宽（CSS 像素，落笔时按画布缩放换算） */
const PEN_WIDTHS = [2, 4, 8];

interface HistoryEntry {
  url: string;
  /** 该快照对应的落笔次数：撤销回空白画布时据此判断内容是否为空 */
  ink: number;
}

interface DoodleBoardProps {
  value: string;
  onChange: (dataUrl: string) => void;
}

/** 默认墨色：跟随主题文字色（亮色深墨 / 暗色浅墨），首次挂载时读取 */
function initialInkColor(): string {
  const themed = getComputedStyle(document.documentElement)
    .getPropertyValue("--text")
    .trim();
  return themed || "#1f2937";
}

/**
 * 手写涂鸦板：指针绘制 + 颜色 / 笔宽 / 橡皮 / 撤销 / 清空。
 * 画布保持透明，导出 PNG data URL 交给详情防抖保存；卡片背景透出纸张底色。
 */
export function DoodleBoard({ value, onChange }: DoodleBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState(initialInkColor);
  const [width, setWidth] = useState(PEN_WIDTHS[1]);
  const [eraser, setEraser] = useState(false);
  // 撤销栈 / 落笔计数：只在事件里读写，不参与渲染
  const historyRef = useRef<HistoryEntry[]>([]);
  const inkRef = useRef(0);
  const drawingRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });
  // 初始内容只挂载时绘制一次，避免保存回写后重绘打断正在画的笔画
  const initialValueRef = useRef(value);

  const emit = (): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onChange(inkRef.current > 0 ? canvas.toDataURL("image/png") : "");
  };

  /** 按当前工具配置画笔：橡皮用 destination-out 擦除已有笔迹 */
  const configure = (ctx: CanvasRenderingContext2D): void => {
    const canvas = canvasRef.current;
    const scale = canvas ? canvas.width / canvas.getBoundingClientRect().width : 1;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = width * scale;
    ctx.globalCompositeOperation = eraser ? "destination-out" : "source-over";
    ctx.strokeStyle = color;
  };

  const toCanvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return;
    const canvas = event.currentTarget;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // 合成事件（自动化测试）没有活动指针，捕获会抛错；真实指针下保持拖出画布仍能继续画
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // 忽略：无活动指针时退化为普通事件流
    }
    historyRef.current.push({ url: canvas.toDataURL("image/png"), ink: inkRef.current });
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
    drawingRef.current = true;
    const point = toCanvasPoint(event);
    lastPointRef.current = point;
    // 单击也留下一个圆点
    configure(ctx);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x + 0.01, point.y);
    ctx.stroke();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current) return;
    const ctx = event.currentTarget.getContext("2d");
    if (!ctx) return;
    const point = toCanvasPoint(event);
    const last = lastPointRef.current;
    configure(ctx);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
  };

  const finishStroke = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 忽略：合成事件未捕获指针
    }
    if (!eraser) inkRef.current += 1;
    emit();
  };

  // 挂载时载入已有涂鸦
  useEffect(() => {
    const src = initialValueRef.current;
    const canvas = canvasRef.current;
    if (!src || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = src;
    inkRef.current = 1;
  }, []);

  const undo = (): void => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const prev = historyRef.current.pop();
    if (!canvas || !ctx || !prev) return;
    const img = new Image();
    img.onload = () => {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      inkRef.current = prev.ink;
      emit();
    };
    img.src = prev.url;
  };

  const clear = (): void => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    historyRef.current.push({ url: canvas.toDataURL("image/png"), ink: inkRef.current });
    if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    inkRef.current = 0;
    emit();
  };

  return (
    <div
      className="doodle-board flex-1 min-h-0"
      data-tauri-drag-region="false"
    >
      <div className="doodle-toolbar" data-tauri-drag-region="false">
        <div className="doodle-group" role="group" aria-label="画笔颜色">
          {PEN_COLORS.map((item) => (
            <button
              key={item.value}
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-pressed={!eraser && color === item.value}
              onClick={() => {
                setColor(item.value);
                setEraser(false);
              }}
              className={`doodle-swatch${
                !eraser && color === item.value ? " is-active" : ""
              }`}
              style={{ backgroundColor: item.value }}
            />
          ))}
        </div>
        <div className="doodle-group" role="group" aria-label="笔宽">
          {PEN_WIDTHS.map((item) => (
            <button
              key={item}
              type="button"
              title={`${item}px`}
              aria-label={`笔宽 ${item}px`}
              aria-pressed={width === item}
              onClick={() => setWidth(item)}
              className={`doodle-width${width === item ? " is-active" : ""}`}
            >
              <span style={{ width: item, height: item }} />
            </button>
          ))}
        </div>
        <div className="doodle-group doodle-group-actions">
          <Tooltip title="橡皮">
            <Button
              type={eraser ? "primary" : "text"}
              size="small"
              className="doodle-btn"
              aria-pressed={eraser}
              icon={<ClearOutlined />}
              onClick={() => setEraser((prev) => !prev)}
            />
          </Tooltip>
          <Tooltip title="撤销">
            <Button
              type="text"
              size="small"
              className="doodle-btn"
              icon={<UndoOutlined />}
              onClick={undo}
            />
          </Tooltip>
          <Popconfirm
            title="清空画布"
            okText="清空"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={clear}
          >
            <Tooltip title="清空">
              <Button
                type="text"
                danger
                size="small"
                className="doodle-btn"
                icon={<DeleteOutlined />}
              />
            </Tooltip>
          </Popconfirm>
        </div>
      </div>
      <div className="doodle-stage">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="doodle-canvas"
          aria-label={eraser ? "涂鸦画布（橡皮）" : "涂鸦画布"}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
        />
        <span className="doodle-hint">
          <EditOutlined /> 按住拖动即可书写 / 涂画
        </span>
      </div>
    </div>
  );
}
