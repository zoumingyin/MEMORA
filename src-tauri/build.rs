use std::path::Path;

/// vosk 语音识别库（tauri-plugin-stt 依赖）：官方 vosk-api v0.3.45 win64 二进制，
/// 存放在 src-tauri/vosk/。libvosk.lib 供链接期导入；运行期需要
/// libvosk.dll 及其 MinGW 运行时依赖（libgcc/libstdc++/libwinpthread）与 exe 同目录。
/// 本函数同时负责在 dev/test 构建时把 dll 拷到 target/<profile>/ 旁，
/// 保证 `tauri dev` 与 `cargo test` 开箱即用。
fn link_vosk() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 未设置");
    let vosk_dir = Path::new(&manifest_dir).join("vosk");
    println!("cargo:rerun-if-changed={}", vosk_dir.join("libvosk.lib").display());
    println!(
        "cargo:rustc-link-search=native={}",
        vosk_dir.display()
    );

    // 拷贝运行期 dll 到 target/<profile>/（OUT_DIR = target/<profile>/build/<pkg>/out，
    // 三级父目录即 target/<profile>/）。仅在缺失时拷贝，避免每次构建重复写盘。
    let out_dir_buf = std::env::var("OUT_DIR").expect("OUT_DIR 未设置");
    let out_dir = Path::new(&out_dir_buf);
    let target_profile_dir = out_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .expect("无法从 OUT_DIR 推导 target 目录");
    for dll in [
        "libvosk.dll",
        "libgcc_s_seh-1.dll",
        "libstdc++-6.dll",
        "libwinpthread-1.dll",
    ] {
        let from = vosk_dir.join(dll);
        let to = target_profile_dir.join(dll);
        if !to.exists() && from.exists() {
            if let Err(error) = std::fs::copy(&from, &to) {
                println!("cargo:warning=拷贝 {dll} 失败: {error}");
            }
        }
    }
}

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
    link_vosk();
    tauri_build::build()
}
