import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AudioOutlined, LoadingOutlined } from "@ant-design/icons";
import { isTauriRuntime } from "../repository";
import { useVoiceInput } from "../hooks/useVoiceInput";

interface VoiceInputButtonProps {
  /** 识别出的文本（追加语义，由调用方拼进输入框；结果可直接编辑） */
  onText: (text: string) => void;
  /** 语音识别不可用 / 录音过短等业务提示（权限类错误组件内已展示，不重复回调） */
  onError?: (message: string) => void;
  /** 桌面版唤起系统听写前把目标输入框聚焦（Win+H 的文本打进聚焦框） */
  onBeforeTrigger?: () => void;
  disabled?: boolean;
}

const formatElapsed = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** 音量动效条：音量越大点亮的格子越多 */
const VOLUME_BARS = 5;

/**
 * 语音输入按钮：
 * - 桌面版：唤起 Windows 系统语音输入（Win+H，原生听写、免配置），文本直接打进聚焦的输入框；
 * - 浏览器（Chrome/Edge）：Web Speech 实时转写（录音时长 + 音量动效 + 中间结果预览），
 *   不可用时降级 whisper 转写。
 * 权限被拒绝等错误在面板内联展示，转写文本由调用方填入输入框。
 */
export function VoiceInputButton({
  onText,
  onError,
  onBeforeTrigger,
  disabled,
}: VoiceInputButtonProps) {
  const { state, start, stop } = useVoiceInput({ onText });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const errorTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
      if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    };
  }, []);

  const showError = (message: string): void => {
    setNotice(null);
    setError(message);
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => setError(null), 8000);
  };

  const showNotice = (message: string): void => {
    setError(null);
    setNotice(message);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 6000);
  };

  const handleToggle = (): void => {
    if (state.transcribing) return;
    // 桌面版：唤起系统听写（Win+H），不依赖 AI 配置，也不抢录音设备
    if (isTauriRuntime()) {
      if (state.active) return;
      onBeforeTrigger?.();
      invoke("open_system_voice_input")
        .then(() => {
          showNotice(
            "已唤起系统语音输入：直接说话，说完点面板上的「完成」，文字会打进输入框",
          );
        })
        .catch((error: unknown) => {
          const message =
            typeof error === "string"
              ? error
              : error instanceof Error
                ? error.message
                : "无法唤起系统语音输入，请手动按 Win+H";
          showError(message);
        });
      return;
    }
    if (state.active) {
      void stop().catch((error: unknown) => {
        // Tauri invoke 失败 reject 的是字符串，直接透传后端原始错误信息
        const message =
          typeof error === "string"
            ? error
            : error instanceof Error
              ? error.message
              : "语音识别失败，请重试";
        showError(message);
        onError?.(message);
      });
      return;
    }
    setError(null);
    void start().catch((error: unknown) => {
      const message =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : "无法启动录音，请重试";
      showError(message);
    });
  };

  const volume = state.active ? state.volume : 0;
  const litBars = Math.round(volume * VOLUME_BARS);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={state.active ? "停止语音输入" : "语音输入"}
          title={
            isTauriRuntime()
              ? "语音输入（系统听写，Win+H）"
              : state.transcribing
                ? "正在转写…"
                : state.active
                  ? "停止录音"
                  : "语音输入"
          }
          disabled={disabled || state.transcribing}
          onClick={handleToggle}
          className={`flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] border border-solid transition-colors ${
            state.active
              ? "border-[var(--danger)] bg-[var(--danger)] text-white"
              : "border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--hover-fill)] hover:text-[var(--text)]"
          } ${disabled || state.transcribing ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
        >
          {state.transcribing ? (
            <LoadingOutlined className="text-[14px]" />
          ) : (
            <AudioOutlined className="text-[14px]" />
          )}
        </button>
        {state.active && (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {/* 录音红点脉动 */}
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--danger)] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--danger)]" />
            </span>
            <span className="shrink-0 text-[12px] tabular-nums text-[var(--text)]">
              {formatElapsed(state.elapsedMs)}
            </span>
            {/* 音量动效条 */}
            <span className="flex shrink-0 items-end gap-[2px]">
              {Array.from({ length: VOLUME_BARS }, (_, index) => (
                <span
                  key={index}
                  className="w-[3px] rounded-[1px] transition-[height,background-color] duration-100"
                  style={{
                    height: `${4 + index * 3}px`,
                    background:
                      index < litBars
                        ? "var(--danger)"
                        : "var(--border)",
                  }}
                />
              ))}
            </span>
            {state.interim && (
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-muted)]">
                {state.interim}
              </span>
            )}
          </span>
        )}
        {state.transcribing && (
          <span className="shrink-0 text-[12px] text-[var(--text-muted)]">
            正在转写…
          </span>
        )}
      </div>
      {error && (
        <span className="break-all text-[11.5px] text-[var(--danger)]">{error}</span>
      )}
      {!error && notice && (
        <span className="break-all text-[11.5px] text-[var(--note)]">{notice}</span>
      )}
    </div>
  );
}
