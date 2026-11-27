import { useEffect, useRef, useState } from "react";
import { AudioOutlined, LoadingOutlined } from "@ant-design/icons";
import { useVoiceInput } from "../hooks/useVoiceInput";

interface VoiceInputButtonProps {
  /** 识别出的文本（追加语义，由调用方拼进输入框；结果可直接编辑） */
  onText: (text: string) => void;
  /** 语音识别不可用 / 录音过短等业务提示（权限类错误组件内已展示，不重复回调） */
  onError?: (message: string) => void;
  /** 桌面版唤起语音识别前把目标输入框聚焦 */
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
 * - 桌面版：tauri-plugin-stt（Vosk 离线识别，模型首次使用自动下载），实时中间结果上屏；
 * - 浏览器（Chrome/Edge）：Web Speech 实时转写（录音时长 + 音量动效），不可用时降级 whisper。
 * 权限被拒绝等错误在面板内联展示，转写文本由调用方填入输入框。
 */
export function VoiceInputButton({
  onText,
  onError,
  onBeforeTrigger,
  disabled,
}: VoiceInputButtonProps) {
  const { state, start, stop } = useVoiceInput({
    onText,
    onError: (message) => {
      showError(message);
      onError?.(message);
    },
  });
  const [error, setError] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    };
  }, []);

  const showError = (message: string): void => {
    setError(message);
    if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => setError(null), 8000);
  };

  const describeError = (error: unknown, fallback: string): string =>
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : fallback;

  const handleToggle = (): void => {
    if (state.transcribing) return;
    if (state.active) {
      void stop().catch((error: unknown) => {
        // Tauri invoke 失败 reject 的是字符串，直接透传后端原始错误信息
        const message = describeError(error, "语音识别失败，请重试");
        showError(message);
        onError?.(message);
      });
      return;
    }
    setError(null);
    // 桌面版：唤起前把目标输入框聚焦，识别结果直接落到输入框
    onBeforeTrigger?.();
    void start().catch((error: unknown) => {
      const message = describeError(error, "无法启动语音识别，请重试");
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
            state.transcribing
              ? "正在转写…"
              : state.active
                ? "停止语音输入"
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
    </div>
  );
}
