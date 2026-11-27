import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../repository";
import { getBrowserCredentials } from "../services/aiClient";

export type VoiceEngine = "speech" | "whisper";

export interface VoiceInputState {
  /** 录音会话进行中（含转写阶段） */
  active: boolean;
  /** 录音已结束、正在等待转写结果（whisper 降级通道） */
  transcribing: boolean;
  /** 本次会话实际使用的转写引擎；null 表示尚未确定 */
  engine: VoiceEngine | null;
  /** 录音时长（毫秒） */
  elapsedMs: number;
  /** 实时音量 0..1（驱动音量动效） */
  volume: number;
  /** 实时中间结果（仅 speech 引擎） */
  interim: string;
}

interface UseVoiceInputOptions {
  /** 识别出的文本（追加语义，由调用方拼进输入框） */
  onText: (text: string) => void;
}

const POLL_INTERVAL_MS = 200;

/** getUserMedia 各错误码 → 用户能看懂的提示 */
function describeMediaError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return isTauriRuntime()
      ? "麦克风权限被拒绝：请到 Windows 设置 → 隐私和安全性 → 麦克风，允许桌面应用访问后重启应用重试"
      : "麦克风权限被拒绝：请点击浏览器地址栏的麦克风图标，允许本站点访问麦克风后重试";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "未检测到麦克风设备：请确认已连接麦克风后重试";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "麦克风被其他应用占用：请关闭占用麦克风的程序（如会议软件）后重试";
  }
  if (error instanceof Error && error.message) return error.message;
  return "无法访问麦克风：请检查设备连接与系统隐私设置后重试";
}

/** blob → base64（分块编码避免超大 call stack） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("录音数据读取失败"));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * 语音输入引擎 hook。
 *
 * 转写通道按环境自动选择：
 * - 浏览器（Chrome/Edge）有 Web Speech API → 实时转写（中间结果即时上屏）；
 * - Web Speech 缺失或启动失败（WebView2 / Firefox / Safari）→ 录完整段，
 *   经 OpenAI 兼容 /audio/transcriptions（whisper）转写：桌面走 ai_transcribe
 *   Rust 代理（密钥不出进程），浏览器直连用户配置。
 *
 * 录音全程 MediaRecorder 兜底采集：speech 引擎正常产出文本时丢弃录音，
 * 产出不足时用录音转写补位。所有资源在会话结束/组件卸载时显式释放。
 */
export function useVoiceInput({ onText }: UseVoiceInputOptions) {
  const [state, setState] = useState<VoiceInputState>({
    active: false,
    transcribing: false,
    engine: null,
    elapsedMs: 0,
    volume: 0,
    interim: "",
  });

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speechBrokenRef = useRef(false);
  const speechFinalRef = useRef("");
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const transcribingRef = useRef(false);

  // 卸载兜底：录音中的组件被卸载（弹窗关闭等）时释放全部资源
  useEffect(() => {
    return () => {
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = useCallback((partial: Partial<VoiceInputState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  function stopAudioMeter(): void {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
  }

  function stopTimer(): void {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  function stopRecognition(): void {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      try {
        recognition.abort();
      } catch {
        // 已停止时忽略
      }
    }
  }

  function releaseStream(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function teardown(): void {
    stopAudioMeter();
    stopTimer();
    stopRecognition();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // 已停止时忽略
      }
    }
    releaseStream();
    chunksRef.current = [];
  }

  const finishTranscribing = useCallback((): void => {
    setState((prev) => ({ ...prev, active: false, transcribing: false }));
    transcribingRef.current = false;
  }, []);

  /** whisper 降级：把录音 blob 发给 OpenAI 兼容转写端点 */
  const transcribeBlob = useCallback(
    async (blob: Blob, mime: string): Promise<void> => {
      setState((prev) => ({ ...prev, transcribing: true, volume: 0 }));
      transcribingRef.current = true;
      try {
        const audioBase64 = await blobToBase64(blob);
        let text: string;
        if (isTauriRuntime()) {
          const result = await invoke<{ text: string }>("ai_transcribe", {
            audioBase64,
            mime,
          });
          text = result.text;
        } else {
          const credentials = getBrowserCredentials();
          if (!credentials) {
            throw new Error(
              "语音转写需要 AI 配置：请先在设置 → AI 助手中配置支持语音识别（whisper）的服务",
            );
          }
          const form = new FormData();
          form.append(
            "file",
            new Blob([blob], { type: mime }),
            `audio.${mime.includes("mp4") ? "m4a" : "webm"}`,
          );
          form.append("model", "whisper-1");
          const response = await fetch(
            `${credentials.baseUrl}/audio/transcriptions`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${credentials.apiKey}` },
              body: form,
            },
          );
          if (!response.ok) {
            const detail = (await response.text()).slice(0, 200);
            throw new Error(
              `语音转写失败（HTTP ${response.status}）：${detail}`,
            );
          }
          const data = (await response.json()) as { text?: string };
          text = (data.text ?? "").trim();
        }
        if (!text) {
          throw new Error("未识别到语音内容，请离麦克风近一点后重试");
        }
        onTextRef.current(text);
      } finally {
        finishTranscribing();
      }
    },
    [finishTranscribing],
  );

  const start = useCallback(async (): Promise<void> => {
    if (state.active || transcribingRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前环境不支持麦克风录音");
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      throw new Error(describeMediaError(error));
    }
    streamRef.current = stream;
    chunksRef.current = [];
    speechBrokenRef.current = false;
    speechFinalRef.current = "";
    startedAtRef.current = Date.now();
    setState({
      active: true,
      transcribing: false,
      engine: null,
      elapsedMs: 0,
      volume: 0,
      interim: "",
    });

    // 音量动效：AnalyserNode RMS → 0..1
    try {
      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);
        const tick = (): void => {
          if (!audioCtxRef.current) return;
          analyser.getFloatTimeDomainData(buffer);
          let sum = 0;
          for (const sample of buffer) sum += sample * sample;
          const rms = Math.sqrt(sum / buffer.length);
          patch({ volume: Math.min(1, rms * 6) });
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      }
    } catch {
      // 音量动效失败不影响录音主流程
    }

    // 计时
    timerRef.current = window.setInterval(() => {
      patch({ elapsedMs: Date.now() - startedAtRef.current });
    }, POLL_INTERVAL_MS);

    // 兜底采集：无论走哪条转写通道都录下来
    try {
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start(1000);
    } catch {
      recorderRef.current = null;
    }

    // 实时转写通道：Web Speech API（浏览器 Chrome/Edge 可用；WebView2 存在构造
    // 但 start 后报 service-not-allowed，靠 onerror 降级）
    const Ctor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
    if (Ctor) {
      try {
        const recognition = new Ctor();
        recognition.lang = "zh-CN";
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.onresult = (event) => {
          let interim = "";
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            const transcript = result[0]?.transcript ?? "";
            if (result.isFinal) {
              const trimmed = transcript.trim();
              if (trimmed) {
                speechFinalRef.current += (speechFinalRef.current ? "" : "") + trimmed;
                onTextRef.current(trimmed);
              }
            } else {
              interim += transcript;
            }
          }
          patch({ interim, engine: "speech" });
        };
        recognition.onerror = (event) => {
          // not-allowed / service-not-allowed：WebView2 或无语音服务 → 停用实时通道，
          // MediaRecorder 的录音在 stop 时走 whisper 转写补位
          if (
            event.error === "not-allowed" ||
            event.error === "service-not-allowed" ||
            event.error === "network"
          ) {
            speechBrokenRef.current = true;
          }
        };
        recognition.onend = () => {
          // Chrome 会话自动截断：录音仍进行中时重启续录
          if (recognitionRef.current === recognition && !speechBrokenRef.current) {
            try {
              recognition.start();
            } catch {
              speechBrokenRef.current = true;
            }
          }
        };
        recognitionRef.current = recognition;
        recognition.start();
      } catch {
        speechBrokenRef.current = true;
      }
    }
  }, [state.active, patch]);

  const stop = useCallback(async (): Promise<void> => {
    if (!state.active || transcribingRef.current) return;
    stopTimer();
    stopAudioMeter();
    stopRecognition();
    patch({ volume: 0, interim: "" });

    const elapsed = Date.now() - startedAtRef.current;
    const recorder = recorderRef.current;
    recorderRef.current = null;

    // 实时通道正常产出文本：结束会话，丢弃录音
    if (!speechBrokenRef.current && speechFinalRef.current.trim()) {
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch {
          // 已停止时忽略
        }
      }
      releaseStream();
      setState({
        active: false,
        transcribing: false,
        engine: "speech",
        elapsedMs: elapsed,
        volume: 0,
        interim: "",
      });
      return;
    }

    // 降级通道：等 recorder 把最后一段数据吐出来再转写
    const recordedMime =
      recorder?.mimeType && recorder.mimeType.length > 0
        ? recorder.mimeType
        : "audio/webm";
    const blobPromise = new Promise<Blob>((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        resolve(new Blob(chunksRef.current));
        return;
      }
      recorder.onstop = () => resolve(new Blob(chunksRef.current));
      try {
        recorder.stop();
      } catch {
        resolve(new Blob(chunksRef.current));
      }
    });
    releaseStream();
    const blob = await blobPromise;
    const mime = blob.type || recordedMime;
    setState({
      active: false,
      transcribing: true,
      engine: "whisper",
      elapsedMs: elapsed,
      volume: 0,
      interim: "",
    });
    try {
      await transcribeBlob(blob, mime);
    } catch (error) {
      finishTranscribing();
      throw error;
    }
  }, [state.active, patch, transcribeBlob, finishTranscribing]);

  const cancel = useCallback((): void => {
    teardown();
    setState({
      active: false,
      transcribing: false,
      engine: null,
      elapsedMs: 0,
      volume: 0,
      interim: "",
    });
  }, []);

  const reset = useCallback((): void => {
    if (!state.active && !transcribingRef.current) return;
    cancel();
  }, [cancel, state.active]);

  return useMemo(
    () => ({ state, start, stop, cancel, reset }),
    [state, start, stop, cancel, reset],
  );
}
