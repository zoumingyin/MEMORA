# vosk 语音识别库（Windows x86_64）

来源：[vosk-api v0.3.45 官方 release](https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip) 的 `vosk-win64-0.3.45.zip`。

`tauri-plugin-stt = "0.1"` 桌面端通过 `vosk`/`vosk-sys` crate 静态链接本目录的
`libvosk.lib`（链接期导入库，由 `build.rs` 的 `link_vosk()` 注册搜索路径）。

运行期需要以下 4 个 dll 与 exe 同目录：

- `libvosk.dll` — Vosk 识别引擎本体
- `libgcc_s_seh-1.dll` / `libstdc++-6.dll` / `libwinpthread-1.dll` — dll 的 MinGW 运行时依赖

- `tauri dev` / `cargo test`：`build.rs` 在构建时自动把 4 个 dll 拷贝到
  `target/<profile>/`，无需手动操作。
- NSIS 安装包：`tauri.conf.json` 的 `bundle.resources` 已将 4 个 dll 映射到安装根目录
  （与 exe 同目录）。
- 识别模型（中文约 40MB+）不在此目录，插件在首次使用时按语言自动下载到系统
  数据目录（`vosk-models` 子目录）。

若升级 vosk 版本，替换本目录同名文件并同步更新版本说明即可。
