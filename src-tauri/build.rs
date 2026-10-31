use std::path::Path;

/// 可选的本机构建密钥：放在 src-tauri/keys/opencode.key（该目录已 gitignore）。
/// 构建时注入为编译期常量，打包后的 exe 自带密钥，不依赖运行时的环境变量、
/// 配置文件或安装路径；文件缺失时置空，构建照常通过。
fn inject_builtin_keys() {
    let path = Path::new("keys/opencode.key");
    println!("cargo:rerun-if-changed={}", path.display());
    let key = std::fs::read_to_string(path)
        .map(|raw| raw.trim().to_string())
        .unwrap_or_default();
    if key.is_empty() {
        println!(
            "cargo:warning=未找到 keys/opencode.key，构建产物将不内置 OpenCode 密钥"
        );
    }
    println!("cargo:rustc-env=BIANQIAN_BUILTIN_OPENCODE_KEY={key}");
}

fn main() {
    inject_builtin_keys();
    tauri_build::build()
}
