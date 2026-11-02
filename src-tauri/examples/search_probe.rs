//! 端到端验证探针：直接调用 `ai_web_search` 命令（含系统代理失败后直连
//! 重试的完整容错流程），打印解析出的结构化搜索结果。
//! 用法：cargo run --example search_probe -- "搜索词"
#![allow(clippy::print_literal)]

#[tokio::main]
async fn main() {
    let query = std::env::args().nth(1).unwrap_or_else(|| "tauri 2 发布".into());
    println!("搜索词：{query}");
    match bianqian_lib::web_search::ai_web_search(query).await {
        Ok(results) => {
            println!("成功，共 {} 条结果：", results.len());
            for (index, result) in results.iter().enumerate() {
                println!("[{}] {}", index + 1, result.title);
                println!("    {}", result.snippet);
                println!("    来源: {}", result.url);
                if let Some(content) = &result.content {
                    println!("    正文摘录: {}…", content.chars().take(80).collect::<String>());
                } else {
                    println!("    正文摘录: （无）");
                }
            }
        }
        Err(error) => {
            println!("失败：{error}");
            std::process::exit(1);
        }
    }
}
