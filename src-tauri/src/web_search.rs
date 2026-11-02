//! 联网搜索：桌面端代理抓取必应（国内版）搜索结果，供 AI 助手注入实时上下文。
//!
//! 为什么走 Rust 后端：搜索引擎不允许跨域（CORS），浏览器预览直连必失败，
//! 桌面端由后端请求则没有此限制。浏览器预览在前端直接提示改用桌面版。
//! 只做 GET + 无状态解析，不引入正则 / HTML 解析 crate，保持依赖最小。
//!
//! 质量与容错设计（针对实测发现的问题逐层防御）：
//! 1. 结果块 class 存在多 class 变体（`b_algo focus_business` 等）——标记匹配
//!    不带闭引号，并校验后续字符，兼容所有变体又不误匹配 `b_algo_xxx`；
//! 2. 口语化查询（「今天有哪些前端资讯」）会让必应命中「今天」返回黄历/天气页
//!    ——发送前先清洗掉对话填充词，只保留实义关键词；
//! 3. 泛化查询的返回可能被单一站点刷屏、或混入搜索引擎入口页——过滤垃圾来源、
//!    同一主机最多保留 2 条，从 15 条候选里凑出 6 条；
//! 4. 摘要只有一两句、入口页没有实质内容——抓取前 3 条结果页的正文摘录一并注入，
//!    让模型拿到可引用的实义内容（SPA 空壳 / 反爬页拿不到正文时自动跳过）；
//! 5. 系统代理（system-proxy feature）出口 IP 可能触发必应人机验证页 / 空布局
//!    ——首次请求失败后绕过代理直连重试一次；
//! 6. 确实无结果 / 需要验证 / 结构变化——分类返回可操作的错误信息，
//!    前端展示「联网搜索失败：<原因>」并降级为普通回答。

use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 单条搜索结果（serde camelCase 与前端 `WebSearchResult` 对应）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    /// 结果页正文摘录（仅前几条结果抓取；SPA 空壳或反爬页为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// 注入提示词的条数上限：控制提示词体积，前几条通常已足够
const MAX_RESULTS: usize = 6;
/// 候选拉取数：过滤垃圾来源与主机去重后仍能凑满 MAX_RESULTS
const CANDIDATE_COUNT: usize = 15;
/// 同一主机最多保留的结果条数：防止单一站点刷屏
const MAX_PER_HOST: usize = 2;
/// 抓取正文摘录的结果条数（并行抓取，控制总耗时）
const ENRICH_TOP_N: usize = 3;
/// 单条标题 / 摘要 / 链接 / 正文的字符上限（按字符截断，中文友好）
const MAX_TITLE_CHARS: usize = 120;
const MAX_SNIPPET_CHARS: usize = 220;
const MAX_URL_CHARS: usize = 500;
const MAX_PAGE_CHARS: usize = 500;
/// 查询词长度上限：过长会被搜索引擎拒绝
const MAX_QUERY_CHARS: usize = 120;
/// 正文摘录的最短有效长度：低于此视为没抓到正文（SPA 空壳等）
const MIN_PAGE_TEXT_CHARS: usize = 60;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 联网搜索命令：抓取必应国内版搜索结果并解析为结构化条目。
/// 第一次请求跟随系统代理（部分网络必须走代理）；解析为空时绕过代理
/// 直连重试一次。
#[tauri::command]
pub async fn ai_web_search(query: String) -> Result<Vec<WebSearchResult>, String> {
    let query = normalize_query(query)?;
    // 「确实无结果」无需重试；其余错误（网络 / 验证页 / 结构变化）换直连再试
    let mut last_error = String::new();
    for direct in [false, true] {
        match fetch_bing_results(&query, direct).await {
            Ok(results) => return Ok(results),
            Err(error) => {
                if error.contains("没有搜索到相关结果") {
                    return Err(error);
                }
                last_error = error;
            }
        }
    }
    Err(last_error)
}

/// 查询词清洗：去首尾空白、截断超长输入，并剔除对话填充词——
/// 必应对「今天有哪些前端资讯」这类整句会把「今天」当主关键词，
/// 返回黄历、天气等无关页面；清洗后只保留实义关键词（「前端资讯」）。
fn normalize_query(query: String) -> Result<String, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("搜索内容为空".to_string());
    }
    let cleaned = strip_filler_words(&query);
    let final_query = if cleaned.is_empty() {
        // 清洗后为空（整句都是填充词）：退回原始查询
        query
    } else {
        cleaned
    };
    Ok(final_query.chars().take(MAX_QUERY_CHARS).collect())
}

/// 对话填充词表：按长度降序替换，避免短词先替换破坏长词匹配。
/// 只剔除不影响搜索意图的功能词，保留「最新」「发布」等实义词。
const FILLER_WORDS: &[&str] = &[
    // 委托 / 疑问引导
    "帮我看看", "帮我查一下", "帮我查", "帮我", "请问", "我想知道", "我想了解",
    "我想问问", "告诉我", "查一下", "查询一下", "给我讲讲", "给我说说",
    // 罗列 / 总结类引导
    "介绍一下", "介绍下", "总结一下", "总结下", "梳理一下", "梳理下",
    "整理一下", "整理下", "列举一下", "有哪些", "都有哪些", "有什么", "都有什么",
    // 时间 / 状态填充（保留「最新」「发布」等实义词）
    "今天有", "今天", "最近有", "最近", "现在有", "现在", "目前", "当前有", "当前",
    // 语气词
    "吗", "呢", "吧", "啊", "么", "哦",
];

fn strip_filler_words(query: &str) -> String {
    let mut cleaned = query.to_string();
    let mut fillers: Vec<&str> = FILLER_WORDS.to_vec();
    // 长词优先替换，防止短词先命中破坏长词
    fillers.sort_by_key(|word| std::cmp::Reverse(word.chars().count()));
    for filler in fillers {
        cleaned = cleaned.replace(filler, " ");
    }
    // 压缩空白与残留标点
    cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|c: char| "，。？、；！,.?！".contains(c))
        .to_string()
}

/// 抓取并解析一次搜索结果；`direct` 为 true 时绕过系统代理直连
async fn fetch_bing_results(query: &str, direct: bool) -> Result<Vec<WebSearchResult>, String> {
    let html = fetch_search_html(query, direct).await?;
    let results = filter_results(parse_bing_results(&html));
    if !results.is_empty() {
        let mut results = results;
        enrich_top_pages(&mut results).await;
        return Ok(results);
    }
    match diagnose_empty_page(&html) {
        Some(reason) => Err(reason),
        None => Err("搜索没有返回结果（页面结构可能已变化，请稍后重试）".to_string()),
    }
}

async fn fetch_search_html(query: &str, direct: bool) -> Result<String, String> {
    // 独立的短超时客户端：搜索是单次快速请求，与 AI 对话的长连接客户端隔离
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15));
    if direct {
        // 绕过系统代理 / 环境变量代理，强制直连
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|error| format!("初始化网络客户端失败：{error}"))?;

    let response = client
        .get("https://cn.bing.com/search")
        .query(&[
            ("q", query),
            ("mkt", "zh-CN"),
            ("count", CANDIDATE_COUNT.to_string().as_str()),
        ])
        .header("User-Agent", USER_AGENT)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|error| {
            if direct {
                format!("无法连接搜索服务：{error}")
            } else {
                format!("无法连接搜索服务（系统代理）：{error}")
            }
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "搜索服务返回错误（HTTP {}）",
            response.status().as_u16()
        ));
    }
    response
        .text()
        .await
        .map_err(|error| format!("读取搜索结果失败：{error}"))
}

/// 搜索引擎 / 导航站的域名黑名单：这些站点的主页作为「搜索结果」没有任何信息量，
/// 是模型答「只搜到入口页」的直接原因
const JUNK_HOSTS: &[&str] = &[
    "baidu.com",
    "sogou.com",
    "so.com",
    "google.com",
    "bing.com",
    "hao123.com",
    "hao.360.com",
    "2345.com",
    "265.com",
];

/// 提取 URL 主机名并去掉 www / m 前缀
fn host_of(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://")?.1;
    let host = after_scheme.split(['/']).next()?;
    if host.is_empty() {
        return None;
    }
    let lowered = host.to_ascii_lowercase();
    let stripped = lowered
        .strip_prefix("www.")
        .or_else(|| lowered.strip_prefix("m."))
        .unwrap_or(&lowered);
    Some(stripped.to_string())
}

fn is_junk_source(url: &str) -> bool {
    let Some(host) = host_of(url) else {
        return true;
    };
    JUNK_HOSTS
        .iter()
        .any(|junk| host == *junk || host.ends_with(&format!(".{junk}")))
}

/// 结果后处理：过滤垃圾来源、同一主机去重（最多 MAX_PER_HOST 条）
fn filter_results(results: Vec<WebSearchResult>) -> Vec<WebSearchResult> {
    let mut kept: Vec<WebSearchResult> = Vec::new();
    let mut host_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for result in results {
        if is_junk_source(&result.url) {
            continue;
        }
        let Some(host) = host_of(&result.url) else {
            continue;
        };
        let count = host_counts.entry(host).or_default();
        if *count >= MAX_PER_HOST {
            continue;
        }
        *count += 1;
        kept.push(result);
        if kept.len() >= MAX_RESULTS {
            break;
        }
    }
    kept
}

/// 抓取前 ENRICH_TOP_N 条结果页的正文摘录：摘要 + 入口页往往没有实质内容，
/// 正文摘录让模型拿到可引用的实义文本。单个页面失败只影响该条（content 为 None）。
async fn enrich_top_pages(results: &mut [WebSearchResult]) {
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(10))
        .build()
    else {
        return;
    };
    let targets: Vec<String> = results
        .iter()
        .take(ENRICH_TOP_N)
        .map(|result| result.url.clone())
        .collect();
    let fetched = join_all(targets.iter().map(|url| {
        let client = client.clone();
        async move { fetch_page_text(&client, url).await }
    }))
    .await;
    for (result, text) in results.iter_mut().zip(fetched) {
        if let Some(text) = text {
            result.content = Some(text);
        }
    }
}

/// 抓取单个结果页并提取正文摘录；任何失败都返回 None（不中断整体流程）
async fn fetch_page_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    // 只取前 512KB：巨型页面的正文都在头部，避免下载整页浪费流量
    let bytes = response.bytes().await.ok()?;
    let head = &bytes[..bytes.len().min(512 * 1024)];
    let html = String::from_utf8_lossy(head);
    extract_page_text(&html, MAX_PAGE_CHARS)
}

/// 从 HTML 提取正文摘录：移除 script / style 等不可见块，剥标签、解码实体、
/// 压缩空白后取前 max_chars 字。文本过短视为 SPA 空壳，返回 None。
fn extract_page_text(html: &str, max_chars: usize) -> Option<String> {
    let without_invisible = remove_tag_blocks(html, &["script", "style", "noscript", "svg"]);
    let text = decode_html_entities(&strip_tags(&without_invisible));
    let collapsed: String = text
        .chars()
        .scan(false, |prev_space, ch| {
            let is_space = ch.is_whitespace();
            if is_space && *prev_space {
                Some(None)
            } else {
                *prev_space = is_space;
                Some(Some(if is_space { ' ' } else { ch }))
            }
        })
        .flatten()
        .collect();
    let trimmed = collapsed.trim();
    if trimmed.chars().count() < MIN_PAGE_TEXT_CHARS {
        return None;
    }
    Some(trimmed.chars().take(max_chars).collect())
}

/// 删除 `<tag ...>...</tag>` 整块内容（script / style 的内部文本不可见，
/// 只剥标签会留下大段 JS 源码污染正文）
fn remove_tag_blocks(html: &str, tags: &[&str]) -> String {
    let mut out = html.to_string();
    for tag in tags {
        let open = format!("<{tag}");
        let close = format!("</{tag}>");
        loop {
            let Some(lower) = out.to_ascii_lowercase().find(&open) else {
                break;
            };
            let Some(gt_rel) = out[lower..].find('>') else {
                break;
            };
            let content_start = lower + gt_rel + 1;
            let lower_tail = out[content_start..].to_ascii_lowercase();
            match lower_tail.find(&close) {
                Some(end_rel) => {
                    let end = content_start + end_rel + close.len();
                    out.replace_range(lower..end, " ");
                }
                // 未闭合的残缺标签：删掉标记之后的全部内容
                None => {
                    out.truncate(lower);
                    break;
                }
            }
        }
    }
    out
}

/// 空结果分类诊断：区分「确实没搜到」与「被要求人机验证」，给出可操作的提示。
/// 验证页判定只用强特征——"challenge" 会出现在正常页的 CSP 白名单与
/// JS key 里（challenges.cloudflare.com / PoWChallengeSolver），不能作为依据。
fn diagnose_empty_page(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    // 必应无结果页的标志文案（中英两版）
    if lower.contains("没有找到") || lower.contains("no results") || lower.contains("did not match")
    {
        Some("该问题没有搜索到相关结果，换个问法试试".to_string())
    } else if lower.contains("captcha")
        || lower.contains("请输入验证码")
        || lower.contains("unusual traffic")
        || lower.contains("prove you are human")
        || lower.contains("prove you're human")
        || lower.contains("异常流量")
    {
        Some("搜索服务要求人机验证，请稍后重试（频繁搜索或使用代理时易触发）".to_string())
    } else {
        None
    }
}

/// 结果块标记：不带闭引号，兼容多 class 变体（`class="b_algo focus_business"` 等）；
/// 命中后校验下一个字符必须是引号或空格，避免误匹配 `b_algo_something`
const RESULT_MARKER: &str = "<li class=\"b_algo";

/// 从必应结果页提取全部结果块；块边界即下一个标记位置
fn parse_bing_results(html: &str) -> Vec<WebSearchResult> {
    let mut results = Vec::new();
    let mut rest = html;
    while let Some(start) = find_result_marker(rest) {
        rest = &rest[start + RESULT_MARKER.len()..];
        let end = find_result_marker(rest).unwrap_or(rest.len());
        if let Some(result) = parse_result_block(&rest[..end]) {
            results.push(result);
        }
    }
    results
}

/// 在 `haystack` 中找结果块标记：`b_algo` 之后必须是引号或空格
fn find_result_marker(haystack: &str) -> Option<usize> {
    let mut from = 0;
    loop {
        let pos = haystack[from..].find(RESULT_MARKER)? + from;
        let next = haystack[pos + RESULT_MARKER.len()..].chars().next();
        match next {
            Some('"') | Some('\'') | Some(' ') => return Some(pos),
            // `b_algo_xxx` 这类同前缀 class：跳过继续找
            Some(_) => from = pos + RESULT_MARKER.len(),
            None => return None,
        }
    }
}

/// 解析单个结果块：优先 `<h2><a href="URL">标题</a></h2>`（结果标题），
/// h2 缺失时退化到块内第一个 http(s) 链接；摘要取 `b_lineclamp` 段落或首个 `<p>`
fn parse_result_block(block: &str) -> Option<WebSearchResult> {
    let (url, title) = extract_link_and_title(block)?;
    let snippet = extract_snippet(block).unwrap_or_default();
    Some(WebSearchResult {
        title: title.chars().take(MAX_TITLE_CHARS).collect(),
        url: url.chars().take(MAX_URL_CHARS).collect(),
        snippet: snippet.chars().take(MAX_SNIPPET_CHARS).collect(),
        content: None,
    })
}

/// 从块中提取链接与标题；链接必须是绝对 http(s) 地址（跳过页内锚点 / 相对路径）
fn extract_link_and_title(block: &str) -> Option<(String, String)> {
    // 结果标题固定在 h2 里；个别布局 h2 缺失时从块头开始扫
    let area = match block.find("<h2") {
        Some(pos) => &block[pos..],
        None => block,
    };
    let mut rest = area;
    for _ in 0..5 {
        let anchor_pos = rest.find("<a ")?;
        let after_anchor = &rest[anchor_pos..];
        if let Some((href, title_text)) = extract_anchor(after_anchor) {
            if href.starts_with("http://") || href.starts_with("https://") {
                let title = decode_html_entities(&title_text);
                if !title.is_empty() {
                    return Some((href, title));
                }
            }
        }
        rest = &after_anchor[3..];
    }
    None
}

/// 解析一个 `<a href="...">标题</a>` 片段；href 兼容单双引号
fn extract_anchor(fragment: &str) -> Option<(String, String)> {
    let (raw_href, href_end) = attribute_value(fragment, "href")?;
    let url = decode_html_entities(raw_href);
    // 标题：href 值结束的 `>` 之后到 `</a>` 之间
    let after_value = &fragment[href_end..];
    let title_start = after_value.find('>')? + 1;
    let title_end = after_value.find("</a>")?;
    if title_start >= title_end {
        return None;
    }
    let title = strip_tags(&after_value[title_start..title_end]);
    Some((url, title))
}

/// 在片段开头附近找 `attr="value"` / `attr='value'`，返回值与值结束位置
fn attribute_value<'a>(fragment: &'a str, attr: &str) -> Option<(&'a str, usize)> {
    for quote in ['"', '\''] {
        let needle = format!("{attr}={quote}");
        if let Some(pos) = fragment.find(&needle) {
            let start = pos + needle.len();
            let rest = &fragment[start..];
            if let Some(end) = rest.find(quote) {
                return Some((&rest[..end], start + end + 1));
            }
        }
    }
    None
}

/// 摘要：优先取 `b_lineclamp` 段落（必应当前的结果摘要标记），
/// 找不到时退化到块内第一个 `<p>...</p>`
fn extract_snippet(block: &str) -> Option<String> {
    if let Some(anchor) = block.find("b_lineclamp") {
        if let Some(p_start) = block[..anchor].rfind("<p") {
            if let Some(text) = extract_tag_text(&block[p_start..]) {
                return Some(text);
            }
        }
    }
    let p_pos = block.find("<p")?;
    extract_tag_text(&block[p_pos..])
}

/// 取 `<p ...>text</p>` 的 text（含标签剥离与实体解码）
fn extract_tag_text(fragment: &str) -> Option<String> {
    let text_start = fragment.find('>')? + 1;
    let text_end = fragment.find("</p>")?;
    if text_start >= text_end {
        return None;
    }
    let text = decode_html_entities(&strip_tags(&fragment[text_start..text_end]));
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// 剥掉 `<...>` 标签：只有正文文本会进入提示词
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut depth = 0usize;
    for ch in html.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            c if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

/// 解码常见 HTML 实体：具名实体按需补充，其余数值实体统一按 Unicode 解析
fn decode_html_entities(input: &str) -> String {
    let trimmed = input.trim();
    if !trimmed.contains('&') {
        return trimmed.to_string();
    }
    let mut out = String::with_capacity(trimmed.len());
    let mut rest = trimmed;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let semicolon = tail.find(';');
        let decoded = semicolon.and_then(|end| decode_entity(&tail[1..end]));
        match (decoded, semicolon) {
            (Some(ch), Some(end)) => {
                out.push(ch);
                rest = &tail[end + 1..];
            }
            // 不认识的实体：原样保留 `&`，继续扫描
            _ => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn decode_entity(entity: &str) -> Option<char> {
    match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" | "ensp" | "emsp" => Some(' '),
        "middot" => Some('·'),
        "hellip" => Some('…'),
        "mdash" => Some('—'),
        "ndash" => Some('–'),
        "ldquo" => Some('“'),
        "rdquo" => Some('”'),
        "lsquo" => Some('‘'),
        "rsquo" => Some('’'),
        _ => {
            let number = entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .map(|hex| u32::from_str_radix(hex, 16).ok())
                .unwrap_or_else(|| entity.strip_prefix('#')?.parse::<u32>().ok());
            number.and_then(char::from_u32)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_common_entities() {
        assert_eq!(decode_html_entities("a&amp;b"), "a&b");
        assert_eq!(decode_html_entities("&#0183;"), "·");
        assert_eq!(decode_html_entities("&#x4e2d;"), "中");
        assert_eq!(decode_html_entities("A&unknownz"), "A&unknownz");
    }

    #[test]
    fn strips_tags_and_keeps_text() {
        assert_eq!(strip_tags("<em>加粗</em>文本"), "加粗文本");
    }

    #[test]
    fn cleans_conversational_queries() {
        assert_eq!(strip_filler_words("今天有哪些前端资讯"), "前端资讯");
        assert_eq!(strip_filler_words("请问帮我查一下 React 最新版本"), "React 最新版本");
        assert_eq!(strip_filler_words("最近有什么值得关注的动态吗"), "值得关注的动态");
        // 清洗后为空时由 normalize_query 退回原始查询
        assert_eq!(strip_filler_words("今天有哪些吗"), "");
    }

    #[test]
    fn parses_bing_result_blocks() {
        let html = r#"<ul id="b_results">
<li class="b_algo"><div><h2><a href="https://example.com/a?x=1&amp;y=2">第一个<em>结果</em></a></h2>
<div class="b_caption"><p class="b_lineclamp4">摘要&amp;内容&#0183;补充</p></div></div></li>
<li class="b_algo"><div><h2><a href="https://example.com/b">第二个结果</a></h2><p>无样式摘要</p></div></li>
</ul>"#;
        let results = parse_bing_results(html);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://example.com/a?x=1&y=2");
        assert_eq!(results[0].title, "第一个结果");
        assert_eq!(results[0].snippet, "摘要&内容·补充");
        assert_eq!(results[1].url, "https://example.com/b");
        assert_eq!(results[1].snippet, "无样式摘要");
    }

    #[test]
    fn parses_multi_class_and_unquoted_attr_variants() {
        // 多 class 变体 + unquoted 属性（实测线上出现过 `<li class="b_algo" data-id iid=SERP.5333>`）
        let html = r#"<li class="b_algo focus_business"><h2><a href="https://e.com/variant">变体结果</a></h2><p>变体摘要</p></li>
<li class="b_algo" data-id iid=SERP.5333><h2><a href="https://e.com/plain">普通结果</a></h2><p>普通摘要</p></li>
<li class="b_algo_head"><h2><a href="https://e.com/head">不该命中</a></h2><p>head 块</p></li>"#;
        let results = parse_bing_results(html);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].url, "https://e.com/variant");
        assert_eq!(results[0].title, "变体结果");
        assert_eq!(results[1].url, "https://e.com/plain");
    }

    #[test]
    fn skips_non_http_links_and_falls_back_to_first_anchor() {
        // h2 缺失时退化到块内第一个 http 链接；页内锚点被跳过
        let html = r##"<li class="b_algo"><div><a href="#cite">引用</a><a href="/relative">相对</a><a href="https://e.com/fallback">回退标题</a></div><p>回退摘要</p></li>"##;
        let results = parse_bing_results(html);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://e.com/fallback");
        assert_eq!(results[0].title, "回退标题");
    }

    #[test]
    fn filters_junk_sources_and_caps_per_host() {
        let results: Vec<WebSearchResult> = [
            ("https://www.baidu.com/s?wd=x", "百度搜索"),
            ("https://example.com/a", "A1"),
            ("https://example.com/b", "A2"),
            ("https://example.com/c", "A3 超出每主机上限"),
            ("https://other.com/d", "B1"),
        ]
        .into_iter()
        .map(|(url, title)| WebSearchResult {
            title: title.to_string(),
            url: url.to_string(),
            snippet: String::new(),
            content: None,
        })
        .collect();
        let kept = filter_results(results);
        // 百度被过滤；example.com 只留 2 条
        assert_eq!(
            kept.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(),
            vec!["A1", "A2", "B1"]
        );
    }

    #[test]
    fn extracts_page_text_without_script_pollution() {
        let html = r#"<html><head><style>body { color: red }</style><script>var x = "js code";</script></head>
<body><h1>页面标题</h1> <p>第一段正文内容，用于判断页面是否有实质信息。</p><p>第二段内容，包含更多上下文与细节描述，确保累积文本长度超过最短有效阈值。</p>
<p>第三段补充说明，模拟真实网页的正文体量，避免测试样例因为太短而被误判为空壳页面。</p></body></html>"#;
        let text = extract_page_text(html, 200).expect("应有正文");
        assert!(text.contains("页面标题"));
        assert!(text.contains("第一段正文"));
        assert!(!text.contains("js code"));
        assert!(!text.contains("color: red"));
    }

    #[test]
    fn short_page_text_is_treated_as_empty() {
        assert_eq!(extract_page_text("<html><body>太短</body></html>", 200), None);
    }

    #[test]
    fn diagnoses_empty_page_variants() {
        assert_eq!(
            diagnose_empty_page("<html>抱歉，没有找到与... 相关的结果</html>").as_deref(),
            Some("该问题没有搜索到相关结果，换个问法试试")
        );
        assert_eq!(
            diagnose_empty_page("<html>unusual traffic from your network</html>").as_deref(),
            Some("搜索服务要求人机验证，请稍后重试（频繁搜索或使用代理时易触发）")
        );
        // 正常结果页里含有 challenges.cloudflare.com（CSP 白名单）：不得误判为验证页
        assert_eq!(
            diagnose_empty_page(r#"<html><script src="challenges.cloudflare.com"></script></html>"#),
            None
        );
        assert_eq!(diagnose_empty_page("<html><li class=\"b_algo\"></html>"), None);
    }

    #[test]
    fn caps_result_count_and_fields() {
        let block = r#"<li class="b_algo"><h2><a href="https://e.com/t">标题</a></h2><p>摘要</p></li>"#;
        let mut html = String::new();
        for _ in 0..10 {
            html.push_str(block);
        }
        // 同主机上限 2 条
        assert_eq!(filter_results(parse_bing_results(&html)).len(), MAX_PER_HOST);
    }
}
