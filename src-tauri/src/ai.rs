//! AI 助手后端：OpenAI 兼容接口代理。
//!
//! 设计要点：
//! - API Key 只存在于 Rust 进程（环境变量或应用数据目录下的 ai-config.json），
//!   永远不回传前端，避免密钥进入 WebView / 对话记录 / 前端 bundle。
//! - 接口按 OpenAI Chat Completions 规范调用，可对接 DeepSeek / Moonshot / 通义 /
//!   智谱 / OpenAI / Ollama 等兼容服务。
//! - 流式响应通过 Tauri Channel 逐段推送，前端边收边渲染；支持请求取消与错误归类。

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{future::join_all, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// 环境变量：优先级高于本地配置文件，适合 CI / 打包部署时注入，避免明文落盘
const ENV_API_KEY: &str = "BIANQIAN_AI_API_KEY";
const ENV_BASE_URL: &str = "BIANQIAN_AI_BASE_URL";
const ENV_MODEL: &str = "BIANQIAN_AI_MODEL";
const ENV_TEMPERATURE: &str = "BIANQIAN_AI_TEMPERATURE";
const ENV_MAX_TOKENS: &str = "BIANQIAN_AI_MAX_TOKENS";

const DEFAULT_TEMPERATURE: f32 = 0.7;
const DEFAULT_MAX_TOKENS: u32 = 1200;

/// 正在进行的请求：request_id 集合，ai_cancel 写入，ai_chat 在分块间检查后提前结束
#[derive(Default)]
pub struct AiState {
    cancelled: Mutex<HashSet<String>>,
}

/// 单个模型配置：一套服务商 + 接入参数，可在对话界面自由切换
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiProfile {
    #[serde(default)]
    id: String,
    /// 展示用名称；为空时回落到模型名
    #[serde(default)]
    name: String,
    /// 服务商名称（预设标签或「自定义服务」），仅用于展示
    #[serde(default)]
    provider: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    /// 明文存放于应用数据目录；权限收紧，且环境变量优先。详见 README「密钥管理」
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    max_tokens: Option<u32>,
}

/// 本地配置文件（v2：多配置列表 + 当前使用项）；保留旧版单配置字段用于迁移
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfig {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    active_id: Option<String>,
    #[serde(default)]
    profiles: Vec<AiProfile>,
    // ===== 旧版（v1）单配置字段：仅在 profiles 为空时转换成一条配置 =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

impl FileConfig {
    /// 旧版单配置 → 列表中的一项（读到即转换，下次保存时落盘）；旧字段迁移后清空
    fn migrated(mut self) -> Self {
        if self.profiles.is_empty() {
            if let (Some(base_url), Some(model)) = (self.base_url.take(), self.model.take()) {
                let profile = AiProfile {
                    // 固定 id：若迁移未落盘，重复读取也必须返回同一个 id，否则前端拿着
                    // 上一次读取的 id 保存会「找不到配置」
                    id: LEGACY_PROFILE_ID.to_string(),
                    name: model.clone(),
                    provider: "自定义服务".to_string(),
                    base_url,
                    model,
                    api_key: self.api_key.take(),
                    temperature: self.temperature.take(),
                    max_tokens: self.max_tokens.take(),
                };
                self.active_id = Some(profile.id.clone());
                self.profiles.push(profile);
            }
        }
        self.version = 2;
        self.base_url = None;
        self.model = None;
        self.api_key = None;
        self.temperature = None;
        self.max_tokens = None;
        self
    }
}


/// 前端提交的单个配置（保存 / 测试用）；id 为空表示新增，apiKey 为空表示沿用已保存密钥
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileInput {
    pub id: Option<String>,
    /// 展示名称；留空时使用模型名
    pub name: Option<String>,
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

/// 单条配置的展示状态（不含明文密钥）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfileStatus {
    id: String,
    name: String,
    provider: String,
    base_url: String,
    model: String,
    key_masked: Option<String>,
    /// env = 环境变量提供；file = 桌面端本机配置；null = 未设置
    key_source: Option<&'static str>,
    configured: bool,
    /// 环境变量注入 / 内置免费模型只读，不能在设置里编辑或删除
    read_only: bool,
    /// 内置免费模型标记（不写入用户配置文件）
    free: bool,
    /// 免费模型来源标识与展示名，用于按来源分组
    source: Option<String>,
    source_label: Option<String>,
    /// 来源说明：限速、隐私提示等
    note: Option<String>,
    temperature: f32,
    max_tokens: u32,
}

/// 单个免费来源的可用状态：用于界面展示「缓存 / 默认 / 暂不可用」
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiFreeSourceStatus {
    source: String,
    label: String,
    base_url: String,
    note: String,
    status: FreeSourceState,
    count: usize,
}

/// 全部配置状态：当前选中的配置 + 配置列表 + 免费来源状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    configured: bool,
    active_id: Option<String>,
    profiles: Vec<AiProfileStatus>,
    free_sources: Vec<AiFreeSourceStatus>,
}

/// 对话消息（与 OpenAI/DeepSeek 等一致）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    /// 前端生成的请求 id，用于取消
    pub request_id: String,
    /// 使用哪条配置；缺省时用当前选中项
    pub profile_id: Option<String>,
    pub messages: Vec<ChatMessage>,
}

/// 流式事件：delta 增量文本 / done 结束 / error 错误（均带 type 标记）
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AiStreamEvent {
    Delta { text: String },
    Done { finish_reason: Option<String> },
    Error { code: String, message: String },
}

#[derive(Debug, Clone)]
struct ResolvedConfig {
    base_url: String,
    model: String,
    api_key: String,
    temperature: f32,
    max_tokens: u32,
    key_source: Option<&'static str>,
    /// 内置免费模型：公共网关本身不校验密钥
    keyless: bool,
    /// 内置免费模型的固定公开令牌（如 OpenCode 的 `Bearer public`）
    bearer: Option<&'static str>,
}

impl ResolvedConfig {
    fn is_complete(&self) -> bool {
        !self.base_url.is_empty()
            && !self.model.is_empty()
            && (!self.api_key.is_empty() || self.keyless || is_local_base_url(&self.base_url))
    }
}

/// 本机 Ollama / LM Studio 等通常不需要密钥：允许密钥为空
fn is_local_base_url(base_url: &str) -> bool {
    let lower = base_url.to_ascii_lowercase();
    lower.starts_with("http://127.0.0.1")
        || lower.starts_with("http://localhost")
        || lower.starts_with("http://[::1]")
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    Ok(dir.join("ai-config.json"))
}

fn read_file_config(app: &AppHandle) -> FileConfig {
    let Ok(path) = config_path(app) else {
        return FileConfig::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return FileConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_else(|error| {
        eprintln!("AI 配置解析失败，按未配置处理：{error}");
        FileConfig::default()
    })
}

fn write_file_config(app: &AppHandle, config: &FileConfig) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建配置目录失败：{error}"))?;
    }
    let raw = serde_json::to_string_pretty(config)
        .map_err(|error| format!("序列化配置失败：{error}"))?;
    std::fs::write(&path, raw).map_err(|error| format!("写入配置失败：{error}"))?;
    // Unix 上收紧为仅当前用户可读写；Windows 依赖应用数据目录的默认用户 ACL
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 读取配置并完成旧版迁移：迁移出配置时立即写回，保证 id 稳定
fn load_file_config(app: &AppHandle) -> FileConfig {
    let raw = read_file_config(app);
    let creates_profile =
        raw.profiles.is_empty() && raw.base_url.is_some() && raw.model.is_some();
    let migrated = raw.migrated();
    if creates_profile {
        if let Err(error) = write_file_config(app, &migrated) {
            eprintln!("AI 配置迁移写回失败（本次仍按迁移结果使用）：{error}");
        }
    }
    migrated
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 配置 id：毫秒时间戳前缀，本地使用足够唯一
fn new_profile_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("p{millis}")
}

const ENV_PROFILE_ID: &str = "env";
/// 旧版单配置迁移后的固定 id（见 FileConfig::migrated）
const LEGACY_PROFILE_ID: &str = "legacy";

/// 环境变量提供的一整条配置（地址 + 模型 + 密钥），在列表中以只读条目展示
fn env_profile() -> Option<AiProfile> {
    let base_url = env_non_empty(ENV_BASE_URL)?;
    let model = env_non_empty(ENV_MODEL)?;
    Some(AiProfile {
        id: ENV_PROFILE_ID.to_string(),
        name: model.clone(),
        provider: "环境变量".to_string(),
        base_url,
        model,
        api_key: env_non_empty(ENV_API_KEY),
        temperature: env_non_empty(ENV_TEMPERATURE).and_then(|value| value.parse::<f32>().ok()),
        max_tokens: env_non_empty(ENV_MAX_TOKENS).and_then(|value| value.parse::<u32>().ok()),
    })
}

/// 内置免费网关：这里只描述接口地址、公开令牌与来源说明；
/// 可用模型在运行时经 `GET {base_url}/models` 获取，不在代码里硬编码清单。
/// `fallback` 仅在接口不可用且没有历史缓存时兜底，保证离线也能选到可用模型。
struct FreeProviderSpec {
    source: &'static str,
    label: &'static str,
    base_url: &'static str,
    /// 网关要求的固定公开令牌（OpenCode Zen 用 `Bearer public`）；
    /// 与用户密钥互斥：apiKey 为空时才使用
    bearer: Option<&'static str>,
    note: &'static str,
    fallback: &'static [(&'static str, &'static str)],
}

const FREE_PROVIDERS: &[FreeProviderSpec] = &[
    // ===== OpenCode Zen（主上游：公开 Bearer public 通道） =====
    FreeProviderSpec {
        source: "opencode",
        label: "OpenCode Zen",
        base_url: "https://opencode.ai/inference/v1",
        bearer: Some("public"),
        note: "无需注册；固定 Bearer public；IP 限速，高峰可能 429；提示词可能被上游记录。",
        fallback: &[("deepseek-v4.1-flash", "DeepSeek V4.1 Flash")],
    },
    // ===== Kilo AI 公共网关（免费池，无需账号） =====
    FreeProviderSpec {
        source: "kilo",
        label: "Kilo AI",
        base_url: "https://api.kilo.ai/api/gateway",
        bearer: None,
        note: "无需 Key；自动轮换免费模型，约 200 次/小时；提示词可能被上游记录。",
        fallback: &[("kilo-auto/free", "Auto Free（自动路由）")],
    },
    // ===== LLM7.io（Key 可选，仅用于提升额度） =====
    FreeProviderSpec {
        source: "llm7",
        label: "LLM7.io",
        base_url: "https://api.llm7.io/v1",
        bearer: None,
        note: "无需 Key；匿名约 60 次/分钟、250 次/小时。",
        fallback: &[("gpt-oss-20b", "GPT-OSS 20B")],
    },
    // ===== Pollinations（官方匿名层） =====
    FreeProviderSpec {
        source: "pollinations",
        label: "Pollinations",
        base_url: "https://text.pollinations.ai/openai",
        bearer: None,
        note: "无需 Key；官方匿名层限流较严。",
        fallback: &[("openai-fast", "GPT-OSS 20B（匿名）")],
    },
];

/// 从 `/models` 解析出的单个模型条目；name 缺失时由 id 推导展示名
#[derive(Debug, Clone, Serialize, Deserialize)]
struct FreeModelEntry {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

/// ok = 本次拉取成功；cached = 本次失败但沿用了历史缓存；
/// fallback = 无缓存时使用内置兜底；unavailable = 完全不可用
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FreeSourceState {
    Ok,
    Cached,
    Fallback,
    #[default]
    Unavailable,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct FreeSourceCache {
    #[serde(default)]
    state: FreeSourceState,
    #[serde(default)]
    fetched_at: u64,
    #[serde(default)]
    models: Vec<FreeModelEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct FreeCatalogCache {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    fetched_at: u64,
    #[serde(default)]
    sources: HashMap<String, FreeSourceCache>,
}

static FREE_CACHE: OnceLock<Mutex<FreeCatalogCache>> = OnceLock::new();
static FREE_CACHE_LOADED: AtomicBool = AtomicBool::new(false);

/// 拉取成功后的缓存有效期；失败且已有模型时刻重试间隔
const FREE_CACHE_TTL_SECS: u64 = 6 * 60 * 60;
const FREE_CACHE_RETRY_SECS: u64 = 10 * 60;
/// 单个网关最多展示的模型数，避免选择器过长
const FREE_MODEL_LIMIT: usize = 40;

fn free_cache() -> &'static Mutex<FreeCatalogCache> {
    FREE_CACHE.get_or_init(|| {
        Mutex::new(FreeCatalogCache {
            version: 1,
            ..Default::default()
        })
    })
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn free_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    Ok(dir.join("ai-free-models.json"))
}

/// 首次使用时从磁盘恢复缓存；之后的命令都直接读内存
fn ensure_free_cache_loaded(app: &AppHandle) {
    if FREE_CACHE_LOADED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Ok(path) = free_cache_path(app) else {
        return;
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    match serde_json::from_str::<FreeCatalogCache>(&raw) {
        Ok(cache) => {
            if let Ok(mut guard) = free_cache().lock() {
                *guard = cache;
            }
        }
        Err(error) => eprintln!("免费模型缓存解析失败，将重新获取：{error}"),
    }
}

fn persist_free_cache(app: &AppHandle) {
    let snapshot = match free_cache().lock() {
        Ok(guard) => guard.clone(),
        Err(_) => return,
    };
    let Ok(path) = free_cache_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&snapshot) {
        Ok(raw) => {
            if let Err(error) = std::fs::write(&path, raw) {
                eprintln!("免费模型缓存写入失败：{error}");
            }
        }
        Err(error) => eprintln!("免费模型缓存序列化失败：{error}"),
    }
}

/// 免费模型 id 形如 `free:{source}:{modelId}`；模型 id 自身可能含 `:`，只切前两段
fn parse_free_profile(id: &str) -> Option<(&'static FreeProviderSpec, &str)> {
    let rest = id.strip_prefix("free:")?;
    let (source, model) = rest.split_once(':')?;
    if model.is_empty() {
        return None;
    }
    let provider = FREE_PROVIDERS.iter().find(|item| item.source == source)?;
    Some((provider, model))
}

fn is_free_profile(id: &str) -> bool {
    parse_free_profile(id).is_some()
}

fn free_profile_id(provider: &FreeProviderSpec, model: &str) -> String {
    format!("free:{}:{model}", provider.source)
}

/// 接口未返回 name 时，用模型 id 生成可读名称（去掉 `:free` 后缀、连字符转空格）
fn free_model_name(entry: &FreeModelEntry) -> String {
    if let Some(name) = entry
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        return name.to_string();
    }
    let base = entry.id.split(':').next().unwrap_or(entry.id.as_str());
    let spaced = base.replace(['-', '_'], " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => entry.id.clone(),
    }
}

/// 当前来源可用的模型：优先缓存/最新结果，没有时回退到内置默认
fn source_snapshot(provider: &FreeProviderSpec) -> (Vec<FreeModelEntry>, FreeSourceState) {
    if let Ok(cache) = free_cache().lock() {
        if let Some(entry) = cache.sources.get(provider.source) {
            if !entry.models.is_empty() {
                let state = match entry.state {
                    FreeSourceState::Ok | FreeSourceState::Cached => entry.state,
                    _ => FreeSourceState::Cached,
                };
                return (entry.models.clone(), state);
            }
        }
    }
    if provider.fallback.is_empty() {
        (Vec::new(), FreeSourceState::Unavailable)
    } else {
        let models = provider
            .fallback
            .iter()
            .map(|(id, name)| FreeModelEntry {
                id: (*id).to_string(),
                name: Some((*name).to_string()),
            })
            .collect();
        (models, FreeSourceState::Fallback)
    }
}

/// 免费模型的内存条目：追加在用户配置之后，保持「自己的模型在前、免费模型在后」
fn free_profiles() -> Vec<AiProfile> {
    let mut profiles = Vec::new();
    for provider in FREE_PROVIDERS {
        let (models, _) = source_snapshot(provider);
        for entry in models {
            profiles.push(AiProfile {
                id: free_profile_id(provider, &entry.id),
                name: free_model_name(&entry),
                provider: provider.label.to_string(),
                base_url: provider.base_url.to_string(),
                model: entry.id,
                ..Default::default()
            });
        }
    }
    profiles
}

fn free_catalog_is_fresh() -> bool {
    let Ok(cache) = free_cache().lock() else {
        return false;
    };
    if cache.fetched_at == 0 {
        return false;
    }
    let has_models = cache
        .sources
        .values()
        .any(|source| !source.models.is_empty());
    let ttl = if has_models {
        FREE_CACHE_TTL_SECS
    } else {
        FREE_CACHE_RETRY_SECS
    };
    now_secs().saturating_sub(cache.fetched_at) < ttl
}

/// 运行时拉取单个网关的模型列表：只保留 chat 且免费（若接口给出价格）的条目
async fn fetch_provider_models(
    provider: &'static FreeProviderSpec,
) -> Result<Vec<FreeModelEntry>, String> {
    let client = http_client()?;
    let mut request = client
        .get(models_url(provider.base_url))
        .timeout(Duration::from_secs(10))
        .header("Accept", "application/json");
    if let Some(token) = provider.bearer {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| network_error_message(&error))?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(classify_http_error(status, &body).1);
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("模型列表解析失败：{error}"))?;
    let items = value
        .get("data")
        .and_then(|data| data.as_array())
        .ok_or_else(|| "模型列表格式不符合预期".to_string())?;
    let mut models: Vec<FreeModelEntry> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(|id| id.as_str())?.trim();
            if id.is_empty() {
                return None;
            }
            if let Some(kind) = item.get("type").and_then(|kind| kind.as_str()) {
                if kind != "chat" {
                    return None;
                }
            }
            // 部分网关在同一列表里混有付费模型，价格大于 0 的直接跳过
            if let Some(price) = item
                .pointer("/cost/text/output/price")
                .and_then(|price| price.as_f64())
            {
                if price > 0.0 {
                    return None;
                }
            }
            let name = item
                .get("name")
                .and_then(|name| name.as_str())
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string);
            Some(FreeModelEntry {
                id: id.to_string(),
                name,
            })
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models.truncate(FREE_MODEL_LIMIT);
    if models.is_empty() {
        return Err("服务返回了空的模型列表".to_string());
    }
    Ok(models)
}

/// 并发刷新各网关的模型列表；单个来源失败只影响该来源（沿用缓存 / 默认值）
async fn refresh_free_catalog(app: &AppHandle) {
    ensure_free_cache_loaded(app);
    if free_catalog_is_fresh() {
        return;
    }
    let results = join_all(
        FREE_PROVIDERS
            .iter()
            .map(|provider| fetch_provider_models(provider)),
    )
    .await;
    let fetched_at = now_secs();
    {
        let Ok(mut cache) = free_cache().lock() else {
            return;
        };
        for (provider, result) in FREE_PROVIDERS.iter().zip(results) {
            let previous = cache
                .sources
                .get(provider.source)
                .cloned()
                .unwrap_or_default();
            let entry = match result {
                Ok(models) => FreeSourceCache {
                    state: FreeSourceState::Ok,
                    fetched_at,
                    models,
                },
                Err(error) => {
                    eprintln!("免费模型列表获取失败（{}）：{error}", provider.label);
                    if previous.models.is_empty() {
                        // 不写入空条目，读取时会自动回退到内置默认模型
                        continue;
                    }
                    FreeSourceCache {
                        state: FreeSourceState::Cached,
                        fetched_at: previous.fetched_at,
                        models: previous.models,
                    }
                }
            };
            cache.sources.insert(provider.source.to_string(), entry);
        }
        cache.version = 1;
        cache.fetched_at = fetched_at;
    }
    persist_free_cache(app);
}

fn free_source_statuses() -> Vec<AiFreeSourceStatus> {
    FREE_PROVIDERS
        .iter()
        .map(|provider| {
            let (models, state) = source_snapshot(provider);
            AiFreeSourceStatus {
                source: provider.source.to_string(),
                label: provider.label.to_string(),
                base_url: provider.base_url.to_string(),
                note: provider.note.to_string(),
                status: state,
                count: models.len(),
            }
        })
        .collect()
}

/// 单条配置解析：环境变量密钥优先（部署时统一注入），其余取配置自身
fn resolve_profile(profile: &AiProfile) -> ResolvedConfig {
    let file_key = profile.api_key.clone().unwrap_or_default().trim().to_string();
    let env_key = env_non_empty(ENV_API_KEY);
    let (api_key, key_source) = match env_key {
        Some(key) => (key, Some("env")),
        None if !file_key.is_empty() => (file_key, Some("file")),
        None => (String::new(), None),
    };
    let temperature = env_non_empty(ENV_TEMPERATURE)
        .and_then(|value| value.parse::<f32>().ok())
        .or(profile.temperature)
        .unwrap_or(DEFAULT_TEMPERATURE)
        .clamp(0.0, 2.0);
    let max_tokens = env_non_empty(ENV_MAX_TOKENS)
        .and_then(|value| value.parse::<u32>().ok())
        .or(profile.max_tokens)
        .unwrap_or(DEFAULT_MAX_TOKENS)
        .clamp(64, 8192);

    ResolvedConfig {
        base_url: profile.base_url.trim().trim_end_matches('/').to_string(),
        model: profile.model.trim().to_string(),
        api_key,
        temperature,
        max_tokens,
        key_source,
        keyless: is_free_profile(&profile.id),
        bearer: parse_free_profile(&profile.id).and_then(|(provider, _)| provider.bearer),
    }
}

/// 请求鉴权令牌：用户密钥优先，其次内置免费网关的固定公开令牌
fn auth_token(resolved: &ResolvedConfig) -> Option<&str> {
    if resolved.api_key.is_empty() {
        resolved.bearer
    } else {
        Some(resolved.api_key.as_str())
    }
}

/// 配置文件 + 环境变量条目 + 内置免费模型组成的完整列表。
/// 顺序：环境变量 → 用户配置 → 免费模型，「自己的模型」始终排在免费模型前面。
fn load_profiles(app: &AppHandle) -> (FileConfig, Vec<AiProfile>) {
    ensure_free_cache_loaded(app);
    let file = load_file_config(app);
    let mut all = Vec::with_capacity(file.profiles.len() + FREE_PROVIDERS.len() + 1);
    if let Some(profile) = env_profile() {
        all.push(profile);
    }
    all.extend(file.profiles.iter().cloned());
    all.extend(free_profiles());
    restore_active_free_profile(&file, &mut all);
    (file, all)
}

/// 用户选中的免费模型若已从最新模型列表中消失，仍按 id 还原一条，
/// 否则界面会显示「配置不存在」，而用户并没有删除过它。
fn restore_active_free_profile(file: &FileConfig, all: &mut Vec<AiProfile>) {
    let Some(id) = file.active_id.as_deref() else {
        return;
    };
    if all.iter().any(|profile| profile.id == id) {
        return;
    }
    let Some((provider, model)) = parse_free_profile(id) else {
        return;
    };
    let entry = FreeModelEntry {
        id: model.to_string(),
        name: None,
    };
    all.push(AiProfile {
        id: id.to_string(),
        name: free_model_name(&entry),
        provider: provider.label.to_string(),
        base_url: provider.base_url.to_string(),
        model: entry.id,
        ..Default::default()
    });
}

/// 当前选中项：记录的 id 若已不存在（被删除 / 环境变量移除），回落到第一条用户配置。
/// 免费模型不会被自动选中——首次使用时不应在用户不知情的情况下把内容发给第三方网关。
fn active_profile_id(file: &FileConfig, all: &[AiProfile]) -> Option<String> {
    if let Some(id) = file.active_id.as_deref() {
        if all.iter().any(|profile| profile.id == id) {
            return Some(id.to_string());
        }
    }
    all.iter()
        .find(|profile| !is_free_profile(&profile.id))
        .map(|profile| profile.id.clone())
}

fn find_profile<'a>(all: &'a [AiProfile], id: Option<&str>) -> Option<&'a AiProfile> {
    let id = id?;
    all.iter().find(|profile| profile.id == id)
}

fn mask_key(key: &str) -> Option<String> {
    if key.is_empty() {
        return None;
    }
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return Some("••••".to_string());
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    Some(format!("••••{tail}"))
}

fn profile_status(profile: &AiProfile) -> AiProfileStatus {
    let resolved = resolve_profile(profile);
    let provider = profile.provider.trim();
    let name = profile.name.trim();
    let free = parse_free_profile(&profile.id).map(|(provider, _)| provider);
    AiProfileStatus {
        id: profile.id.clone(),
        name: if name.is_empty() {
            resolved.model.clone()
        } else {
            name.to_string()
        },
        provider: if provider.is_empty() {
            "自定义服务".to_string()
        } else {
            provider.to_string()
        },
        base_url: resolved.base_url.clone(),
        model: resolved.model.clone(),
        key_masked: mask_key(&resolved.api_key),
        key_source: resolved.key_source,
        configured: resolved.is_complete(),
        read_only: profile.id == ENV_PROFILE_ID || free.is_some(),
        free: free.is_some(),
        source: free.map(|provider| provider.source.to_string()),
        source_label: free.map(|provider| provider.label.to_string()),
        note: free.map(|provider| provider.note.to_string()),
        temperature: resolved.temperature,
        max_tokens: resolved.max_tokens,
    }
}

fn status_from(file: &FileConfig, all: &[AiProfile]) -> AiStatus {
    let active_id = active_profile_id(file, all);
    let profiles: Vec<AiProfileStatus> = all.iter().map(profile_status).collect();
    let configured = active_id
        .as_deref()
        .and_then(|id| profiles.iter().find(|status| status.id == id))
        .map(|status| status.configured)
        .unwrap_or(false);
    AiStatus {
        configured,
        active_id,
        profiles,
        free_sources: free_source_statuses(),
    }
}

/// 测试 / 拉取模型时的目标配置：指定 id 优先，其次当前选中项
fn target_profile(app: &AppHandle, profile_id: Option<&str>) -> Option<AiProfile> {
    let (file, all) = load_profiles(app);
    let id = profile_id
        .map(str::to_string)
        .or_else(|| active_profile_id(&file, &all));
    find_profile(&all, id.as_deref()).cloned()
}

/// 兼容用户填入 ``https://api.deepseek.com/v1`` 或完整 endpoint 两种写法
fn chat_completions_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

fn validate_base_url(base_url: &str) -> Result<(), String> {
    if base_url.is_empty() {
        return Err("请填写接口地址（Base URL）".to_string());
    }
    let lower = base_url.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err("接口地址需以 http:// 或 https:// 开头".to_string());
    }
    Ok(())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("初始化网络客户端失败：{error}"))
}

/// 把上游 HTTP 错误转换成稳定错误码 + 可操作的中文提示
fn classify_http_error(status: u16, body: &str) -> (String, String) {
    let detail = extract_error_message(body);
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!("（{detail}）")
    };
    match status {
        401 | 403 => (
            "unauthorized".to_string(),
            format!("API 密钥无效或没有访问权限，请在设置中检查密钥{suffix}"),
        ),
        404 => (
            "endpoint_not_found".to_string(),
            format!("接口地址或模型不存在，请检查 Base URL 与模型名{suffix}"),
        ),
        429 => (
            "rate_limited".to_string(),
            format!("请求过于频繁或额度不足，请稍后重试{suffix}"),
        ),
        500..=599 => (
            "server_error".to_string(),
            format!("AI 服务暂时不可用（HTTP {status}），请稍后重试{suffix}"),
        ),
        _ => (
            "http_error".to_string(),
            format!("AI 服务返回错误（HTTP {status}）{suffix}"),
        ),
    }
}

/// 尽量从 {"error":{"message":...}} / {"message":...} 中取出可读信息
fn extract_error_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
        {
            return message.chars().take(200).collect();
        }
        if let Some(message) = value.get("message").and_then(|message| message.as_str()) {
            return message.chars().take(200).collect();
        }
    }
    let compact: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(200).collect()
}

fn network_error_message(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "网络请求超时，请检查网络连接或稍后重试".to_string()
    } else if error.is_connect() {
        "无法连接到 AI 服务，请检查网络与接口地址".to_string()
    } else {
        format!("网络请求失败：{error}")
    }
}

/// 读取全部配置状态（密钥只返回掩码）；免费模型列表按需刷新，失败时用缓存/默认值
#[tauri::command]
pub async fn ai_get_status(app: AppHandle, force: Option<bool>) -> AiStatus {
    ensure_free_cache_loaded(&app);
    if force.unwrap_or(false) || !free_catalog_is_fresh() {
        refresh_free_catalog(&app).await;
    }
    let (file, all) = load_profiles(&app);
    status_from(&file, &all)
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

/// 生成不与现有配置（含环境变量条目）冲突的 id
fn unique_profile_id(profiles: &[AiProfile]) -> String {
    let mut candidate = new_profile_id();
    let mut suffix = 1;
    while candidate == ENV_PROFILE_ID || profiles.iter().any(|item| item.id == candidate) {
        candidate = format!("{}-{suffix}", new_profile_id());
        suffix += 1;
    }
    candidate
}

/// 新增或更新一条配置：接口地址与模型必填；apiKey 留空则沿用该配置已保存的密钥
#[tauri::command]
pub fn ai_save_profile(app: AppHandle, profile: AiProfileInput) -> Result<AiStatus, String> {
    let base_url = normalize_base_url(profile.base_url.as_deref().unwrap_or_default());
    let model = profile.model.as_deref().unwrap_or_default().trim().to_string();
    validate_base_url(&base_url)?;
    if model.is_empty() {
        return Err("请填写模型名称".to_string());
    }
    // 未填显示名称时默认用模型名，便于在对话界面的选择器里辨识
    let name = profile
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| model.clone());
    let provider = profile
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("自定义服务")
        .to_string();
    let requested_id = profile
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != ENV_PROFILE_ID);
    if let Some(id) = requested_id {
        if is_free_profile(id) {
            return Err("内置免费模型不可修改，请点击「新增模型」创建自己的配置".to_string());
        }
    }

    let mut file = load_file_config(&app);
    let index = requested_id.and_then(|id| {
        file.profiles
            .iter()
            .position(|item| item.id == id)
    });
    match index {
        Some(index) => {
            let item = &mut file.profiles[index];
            item.name = name;
            item.provider = provider;
            item.base_url = base_url;
            item.model = model;
            if let Some(api_key) = profile.api_key {
                let trimmed = api_key.trim();
                if !trimmed.is_empty() {
                    item.api_key = Some(trimmed.to_string());
                }
            }
            // 仅在显式传入时覆盖，避免前端未提供时把已保存的采样参数重置为默认
            if let Some(temperature) = profile.temperature {
                item.temperature = Some(temperature.clamp(0.0, 2.0));
            }
            if let Some(max_tokens) = profile.max_tokens {
                item.max_tokens = Some(max_tokens.clamp(64, 8192));
            }
        }
        None => {
            if requested_id.is_some() {
                return Err("未找到要修改的配置，它可能已被删除".to_string());
            }
            let id = unique_profile_id(&file.profiles);
            file.profiles.push(AiProfile {
                id: id.clone(),
                name,
                provider,
                base_url,
                model,
                api_key: profile
                    .api_key
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                temperature: profile.temperature.map(|value| value.clamp(0.0, 2.0)),
                max_tokens: profile.max_tokens.map(|value| value.clamp(64, 8192)),
            });
            // 新增后直接设为当前使用项：返回对话界面即可用
            file.active_id = Some(id);
        }
    }
    write_file_config(&app, &file)?;
    let (file, all) = load_profiles(&app);
    Ok(status_from(&file, &all))
}

/// 切换对话界面使用的配置
#[tauri::command]
pub fn ai_activate_profile(app: AppHandle, id: String) -> Result<AiStatus, String> {
    let (mut file, all) = load_profiles(&app);
    if find_profile(&all, Some(id.as_str())).is_none() {
        return Err("未找到该模型配置".to_string());
    }
    file.active_id = Some(id);
    write_file_config(&app, &file)?;
    let (file, all) = load_profiles(&app);
    Ok(status_from(&file, &all))
}

/// 删除一条配置；被删除的是当前项时自动切换到剩余的第一条
#[tauri::command]
pub fn ai_delete_profile(app: AppHandle, id: String) -> Result<AiStatus, String> {
    if id == ENV_PROFILE_ID {
        return Err("环境变量注入的配置无法删除，请移除对应环境变量".to_string());
    }
    if is_free_profile(&id) {
        return Err("内置免费模型无需删除，切换到其他模型即可".to_string());
    }
    let mut file = load_file_config(&app);
    let before = file.profiles.len();
    file.profiles.retain(|item| item.id != id);
    if file.profiles.len() == before {
        return Err("未找到该模型配置".to_string());
    }
    if file.active_id.as_deref() == Some(id.as_str()) {
        file.active_id = file.profiles.first().map(|item| item.id.clone());
    }
    write_file_config(&app, &file)?;
    let (file, all) = load_profiles(&app);
    Ok(status_from(&file, &all))
}

/// 清除某条配置保存在本机的密钥（环境变量提供的密钥不受影响）
#[tauri::command]
pub fn ai_clear_key(app: AppHandle, profile_id: Option<String>) -> Result<AiStatus, String> {
    if profile_id.as_deref() == Some(ENV_PROFILE_ID) {
        return Err("该配置的密钥来自环境变量，无法在此清除".to_string());
    }
    if profile_id.as_deref().is_some_and(is_free_profile) {
        return Err("内置免费模型不使用密钥，无需清除".to_string());
    }
    let mut file = load_file_config(&app);
    let target = profile_id
        .or_else(|| file.active_id.clone())
        .or_else(|| file.profiles.first().map(|item| item.id.clone()));
    let Some(target) = target else {
        return Err("尚未配置任何模型".to_string());
    };
    let Some(item) = file.profiles.iter_mut().find(|item| item.id == target) else {
        return Err("未找到该模型配置".to_string());
    };
    item.api_key = None;
    write_file_config(&app, &file)?;
    let (file, all) = load_profiles(&app);
    Ok(status_from(&file, &all))
}

impl Default for ResolvedConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            model: String::new(),
            api_key: String::new(),
            temperature: DEFAULT_TEMPERATURE,
            max_tokens: DEFAULT_MAX_TOKENS,
            key_source: None,
            keyless: false,
            bearer: None,
        }
    }
}

fn apply_override(base: ResolvedConfig, input: Option<AiProfileInput>) -> ResolvedConfig {
    let Some(input) = input else {
        return base;
    };
    ResolvedConfig {
        base_url: input
            .base_url
            .map(|value| normalize_base_url(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or(base.base_url),
        model: input
            .model
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or(base.model),
        api_key: input
            .api_key
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or(base.api_key),
        temperature: input
            .temperature
            .map(|value| value.clamp(0.0, 2.0))
            .unwrap_or(base.temperature),
        max_tokens: input
            .max_tokens
            .map(|value| value.clamp(64, 8192))
            .unwrap_or(base.max_tokens),
        key_source: base.key_source,
        keyless: base.keyless,
        bearer: base.bearer,
    }
}

/// 测试 / 拉取模型时的目标配置：表单里的 id 优先，其次当前使用项；密钥留空时沿用已保存值
fn resolve_target(app: &AppHandle, config: Option<AiProfileInput>) -> ResolvedConfig {
    let base = config
        .as_ref()
        .and_then(|input| input.id.as_deref())
        .and_then(|id| target_profile(app, Some(id)))
        .or_else(|| target_profile(app, None))
        .map(|profile| resolve_profile(&profile))
        .unwrap_or_default();
    apply_override(base, config)
}

#[derive(Deserialize)]
struct TestResponse {
    #[serde(default)]
    choices: Vec<TestChoice>,
}

#[derive(Deserialize)]
struct TestChoice {
    #[serde(default)]
    message: Option<TestMessage>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct TestMessage {
    #[serde(default)]
    content: Option<String>,
}

/// 连通性测试：发一条 max_tokens=1 的最小请求（会消耗极少量额度），返回模型响应摘要
#[tauri::command]
pub async fn ai_test(app: AppHandle, config: Option<AiProfileInput>) -> Result<String, String> {
    let resolved = resolve_target(&app, config);
    validate_base_url(&resolved.base_url)?;
    if resolved.model.is_empty() {
        return Err("请填写模型名称".to_string());
    }
    if resolved.api_key.is_empty()
        && !resolved.keyless
        && !is_local_base_url(&resolved.base_url)
    {
        return Err("请填写 API 密钥".to_string());
    }

    let payload = serde_json::json!({
        "model": resolved.model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 1,
        "stream": false,
    });
    let client = http_client()?;
    let mut request = client
        .post(chat_completions_url(&resolved.base_url))
        .json(&payload);
    if let Some(token) = auth_token(&resolved) {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| network_error_message(&error))?;

    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        let (_, message) = classify_http_error(status, &body);
        return Err(message);
    }
    let parsed: TestResponse = response
        .json()
        .await
        .map_err(|error| format!("响应解析失败：{error}"))?;
    let reply = parsed
        .choices
        .first()
        .and_then(|choice| {
            choice
                .message
                .as_ref()
                .and_then(|message| message.content.clone())
                .or_else(|| choice.finish_reason.clone())
        })
        .unwrap_or_default();
    let summary = if reply.trim().is_empty() {
        "连接成功".to_string()
    } else {
        format!("连接成功：{}", reply.trim().chars().take(40).collect::<String>())
    };
    Ok(format!("{summary}（模型 {}）", resolved.model))
}

#[derive(Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelItem>,
}

#[derive(Deserialize)]
struct ModelItem {
    #[serde(default)]
    id: String,
}

/// 模型列表来自 OpenAI 兼容的 GET /models 接口，失败时由前端回落到内置建议
fn models_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/models") {
        base.to_string()
    } else {
        format!("{base}/models")
    }
}

/// 拉取服务端可用模型（不修改配置；密钥留空时沿用已保存/环境变量密钥）
#[tauri::command]
pub async fn ai_list_models(
    app: AppHandle,
    config: Option<AiProfileInput>,
) -> Result<Vec<String>, String> {
    let resolved = resolve_target(&app, config);
    validate_base_url(&resolved.base_url)?;
    if resolved.api_key.is_empty()
        && !resolved.keyless
        && !is_local_base_url(&resolved.base_url)
    {
        return Err("请填写 API 密钥".to_string());
    }

    let client = http_client()?;
    let mut request = client
        .get(models_url(&resolved.base_url))
        .header("Accept", "application/json");
    if let Some(token) = auth_token(&resolved) {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| network_error_message(&error))?;

    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        let (_, message) = classify_http_error(status, &body);
        return Err(message);
    }

    let parsed: ModelsResponse = response
        .json()
        .await
        .map_err(|error| format!("响应解析失败：{error}"))?;
    let mut models: Vec<String> = parsed
        .data
        .into_iter()
        .map(|item| item.id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    models.sort();
    models.dedup();
    if models.is_empty() {
        return Err("服务返回了空的模型列表，可手动输入模型名".to_string());
    }
    Ok(models)
}

#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}

fn send_event(channel: &Channel<AiStreamEvent>, event: AiStreamEvent) -> bool {
    channel.send(event).is_ok()
}

fn is_cancelled(state: &AiState, request_id: &str) -> bool {
    state
        .cancelled
        .lock()
        .map(|set| set.contains(request_id))
        .unwrap_or(false)
}

enum SseOutcome {
    Continue,
    /// 收到 [DONE]：上游显式结束
    Done,
    /// Channel 发送失败（窗口关闭 / 前端卸载）：停止读取
    Closed,
}

/// 解析单个 SSE 帧：可能有多个 data: 行；容忍 keep-alive 与非 JSON 行
fn process_sse_frame(
    frame: &str,
    channel: &Channel<AiStreamEvent>,
    finish_reason: &mut Option<String>,
    emitted: &mut bool,
) -> SseOutcome {
    for line in frame.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            *finish_reason = Some("stop".to_string());
            return SseOutcome::Done;
        }
        let Ok(parsed) = serde_json::from_str::<StreamChunk>(data) else {
            continue;
        };
        for choice in parsed.choices {
            if let Some(reason) = choice.finish_reason {
                if !reason.is_empty() {
                    *finish_reason = Some(reason);
                }
            }
            if let Some(text) = choice.delta.content {
                if !text.is_empty() {
                    *emitted = true;
                    if !send_event(channel, AiStreamEvent::Delta { text }) {
                        return SseOutcome::Closed;
                    }
                }
            }
        }
    }
    SseOutcome::Continue
}

/// 流式对话：逐块解析 SSE 并推送 delta；配置缺失 / 上游错误 / 取消均以事件形式返回，
/// 保证前端始终能进入明确的结束态。
#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AiState>,
    request: AiChatRequest,
    on_event: Channel<AiStreamEvent>,
) -> Result<(), String> {
    let request_id = request.request_id.clone();
    // 指定配置优先，缺省用当前选中项；找不到时给出可操作的兜底提示
    let (file, all) = load_profiles(&app);
    let target_id = request
        .profile_id
        .clone()
        .or_else(|| active_profile_id(&file, &all));
    let Some(profile) = find_profile(&all, target_id.as_deref()) else {
        let message = if target_id.is_none() {
            "尚未选择模型：可在对话界面顶部选用内置免费模型，或在设置 → AI 助手 → 接入配置中添加自己的模型。"
        } else {
            "所选模型配置不存在，请在对话界面重新选择模型。"
        };
        let _ = send_event(
            &on_event,
            AiStreamEvent::Error {
                code: "not_configured".to_string(),
                message: message.to_string(),
            },
        );
        return Ok(());
    };
    let resolved = resolve_profile(profile);
    if !resolved.is_complete() {
        let _ = send_event(
            &on_event,
            AiStreamEvent::Error {
                code: "not_configured".to_string(),
                message: "当前模型配置不完整：请在设置中检查接口地址、模型与 API 密钥，或切换到其他模型。"
                    .to_string(),
            },
        );
        return Ok(());
    }
    if request.messages.is_empty() {
        let _ = send_event(
            &on_event,
            AiStreamEvent::Error {
                code: "empty_messages".to_string(),
                message: "没有可发送的对话内容。".to_string(),
            },
        );
        return Ok(());
    }

    let payload = serde_json::json!({
        "model": resolved.model,
        "messages": request.messages,
        "temperature": resolved.temperature,
        "max_tokens": resolved.max_tokens,
        "stream": true,
    });

    let client = match http_client() {
        Ok(client) => client,
        Err(message) => {
            let _ = send_event(
                &on_event,
                AiStreamEvent::Error {
                    code: "client_init_failed".to_string(),
                    message,
                },
            );
            return Ok(());
        }
    };

    let mut http_request = client
        .post(chat_completions_url(&resolved.base_url))
        .header("Accept", "text/event-stream")
        .json(&payload);
    // 用户密钥优先；内置免费网关无密钥时使用其固定公开令牌；本机服务则不发 Authorization
    if let Some(token) = auth_token(&resolved) {
        http_request = http_request.bearer_auth(token);
    }

    let response = match http_request.send().await {
        Ok(response) => response,
        Err(error) => {
            let _ = send_event(
                &on_event,
                AiStreamEvent::Error {
                    code: "network_error".to_string(),
                    message: network_error_message(&error),
                },
            );
            return Ok(());
        }
    };

    let status = response.status().as_u16();
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        let (code, message) = classify_http_error(status, &body);
        let _ = send_event(&on_event, AiStreamEvent::Error { code, message });
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut finish_reason: Option<String> = None;
    let mut emitted = false;
    let mut cancelled = false;

    'outer: while let Some(chunk) = stream.next().await {
        if is_cancelled(&state, &request_id) {
            cancelled = true;
            break;
        }
        let bytes = match chunk {
            Ok(bytes) => bytes,
            Err(error) => {
                let _ = send_event(
                    &on_event,
                    AiStreamEvent::Error {
                        code: "stream_error".to_string(),
                        message: network_error_message(&error),
                    },
                );
                return Ok(());
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        // 统一换行：分块可能把 \r\n 拆到两个 chunk，必须在完整 buffer 上归一化
        if buffer.contains('\r') {
            buffer = buffer.replace("\r\n", "\n");
        }

        // SSE 帧以空行分隔；逐帧解析 data: 行，兼容 keep-alive 与多行 data
        while let Some(index) = buffer.find("\n\n") {
            let frame: String = buffer[..index].to_string();
            buffer.drain(..index + 2);
            match process_sse_frame(&frame, &on_event, &mut finish_reason, &mut emitted) {
                SseOutcome::Continue => {}
                SseOutcome::Done => break 'outer,
                SseOutcome::Closed => {
                    cancelled = true;
                    break 'outer;
                }
            }
        }
    }

    // 上游未以空行收尾时，处理缓冲区中最后一个完整帧
    if !cancelled && !buffer.trim().is_empty() {
        if let SseOutcome::Closed =
            process_sse_frame(&buffer, &on_event, &mut finish_reason, &mut emitted)
        {
            cancelled = true;
        }
    }

    if is_cancelled(&state, &request_id) {
        cancelled = true;
    }
    if let Ok(mut set) = state.cancelled.lock() {
        set.remove(&request_id);
    }

    if cancelled {
        let _ = send_event(
            &on_event,
            AiStreamEvent::Done {
                finish_reason: Some("cancelled".to_string()),
            },
        );
        return Ok(());
    }

    if !emitted && finish_reason.is_none() {
        let _ = send_event(
            &on_event,
            AiStreamEvent::Error {
                code: "empty_response".to_string(),
                message: "模型没有返回有效内容，请重试或更换模型。".to_string(),
            },
        );
        return Ok(());
    }

    let _ = send_event(&on_event, AiStreamEvent::Done { finish_reason });
    Ok(())
}

/// 取消进行中的请求：标记后由 ai_chat 在下一个数据块到达时收尾
#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, request_id: String) {
    if let Ok(mut set) = state.cancelled.lock() {
        set.insert(request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_migration_is_stable() {
        let legacy = FileConfig {
            version: 1,
            base_url: Some("https://api.example.com/v1".to_string()),
            model: Some("demo-model".to_string()),
            api_key: Some("sk-legacy".to_string()),
            ..Default::default()
        };
        // 未落盘时重复迁移必须给出同一 id，否则前端拿旧 id 保存会「找不到配置」
        let first = legacy.clone().migrated();
        let second = legacy.migrated();
        assert_eq!(first.profiles.len(), 1);
        assert_eq!(first.profiles[0].id, LEGACY_PROFILE_ID);
        assert_eq!(first.profiles[0].id, second.profiles[0].id);
        assert_eq!(first.profiles[0].name, "demo-model");
        assert_eq!(first.active_id.as_deref(), Some(LEGACY_PROFILE_ID));
        assert_eq!(first.profiles[0].api_key.as_deref(), Some("sk-legacy"));
        assert!(first.base_url.is_none());
        assert_eq!(first.version, 2);
    }

    #[test]
    fn migrated_config_keeps_existing_profiles() {
        let config = FileConfig {
            version: 2,
            active_id: Some("p1".to_string()),
            profiles: vec![AiProfile {
                id: "p1".to_string(),
                name: "已保存".to_string(),
                provider: "OpenAI".to_string(),
                base_url: "https://api.openai.com/v1".to_string(),
                model: "gpt-4o-mini".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let migrated = config.migrated();
        assert_eq!(migrated.profiles.len(), 1);
        assert_eq!(migrated.profiles[0].id, "p1");
        assert_eq!(migrated.active_id.as_deref(), Some("p1"));
    }

    #[test]
    fn free_catalog_is_keyless_and_unique() {
        // 无缓存且拉取失败时，每个来源回退到内置兜底模型，保证列表非空可用
        let profiles = free_profiles();
        let expected: usize = FREE_PROVIDERS
            .iter()
            .map(|provider| provider.fallback.len())
            .sum();
        assert_eq!(profiles.len(), expected);
        let mut ids: Vec<&str> = profiles.iter().map(|profile| profile.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), profiles.len(), "免费模型 id 不应重复");
        for profile in &profiles {
            assert!(profile.id.starts_with("free:"));
            assert!(profile.base_url.starts_with("https://"));
            let resolved = resolve_profile(profile);
            assert!(resolved.keyless, "{} 应视为免密钥配置", profile.id);
            assert!(resolved.is_complete(), "{} 应可直接使用", profile.id);
        }

        // 主上游使用固定公开令牌，不带用户密钥时请求仍应可发出
        let (opencode, model) =
            parse_free_profile("free:opencode:deepseek-v4.1-flash").expect("应含 OpenCode 主上游");
        assert_eq!(opencode.bearer, Some("public"));
        assert_eq!(opencode.base_url, "https://opencode.ai/inference/v1");
        assert_eq!(model, "deepseek-v4.1-flash");
        let resolved = resolve_profile(&AiProfile {
            id: "free:opencode:any-model".to_string(),
            base_url: opencode.base_url.to_string(),
            model: model.to_string(),
            ..Default::default()
        });
        assert_eq!(auth_token(&resolved), Some("public"));
    }

    #[test]
    fn active_fallback_skips_free_profiles() {
        let custom = AiProfile {
            id: "p1".to_string(),
            name: "已保存".to_string(),
            base_url: "https://api.example.com/v1".to_string(),
            model: "demo".to_string(),
            ..Default::default()
        };
        let mut all = vec![custom];
        all.extend(free_profiles());
        let idle = FileConfig::default();
        assert_eq!(active_profile_id(&idle, &all).as_deref(), Some("p1"));

        // 只有免费模型时不自动选中：不应在用户不知情时把内容发给第三方网关
        assert_eq!(active_profile_id(&idle, &free_profiles()), None);

        // 用户显式选择过的免费模型仍然生效
        let free = free_profiles();
        let kilo_id = free
            .iter()
            .find(|profile| profile.id.starts_with("free:kilo:"))
            .expect("应含 Kilo 兜底模型")
            .id
            .clone();
        let picked = FileConfig {
            active_id: Some(kilo_id.clone()),
            ..Default::default()
        };
        assert_eq!(active_profile_id(&picked, &free).as_deref(), Some(kilo_id.as_str()));
    }
}
