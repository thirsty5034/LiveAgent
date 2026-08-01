# LiveAgent 去 Tauri 化（X 路线）— P1 State 解耦详细设计方案

> 文档版本: v1.0 · 2026-08-01
> 仓库: Stack-Cairn/LiveAgent v1.3.0-dev.0 (工作副本: /workspace/LiveAgent, fork: thirsty5034/LiveAgent)
> 目标: 让 LiveAgent 同时支持 **desktop**（Tauri，现状）与 **headless**（无 GUI daemon，WebUI 直连）两种运行模式

---

## 1. 背景与目标

前序调研（P0）已确认两条关键事实：
1. **agent 运行时与 GUI 完全解耦**：`@earendil-works/pi-agent-core` 可纯 Node 运行，最小 agent 闭环验证通过。
2. **Rust 层 headless 编译链可行**：axum+tokio 在无 GTK 环境下编译运行通过；而本机无 GTK3/webkit2gtk/libsoup3，直接编译 tauri 必失败——这正是需要把 tauri 依赖 feature-gate 掉的原因。

P1 目标：**把 src-tauri 中所有 Tauri 耦合点解耦，使业务代码不依赖 tauri 类型**，为 P2 的 headless binary（axum server 替代 Tauri runtime）铺路。P1 本身不改变任何运行时行为（纯重构），desktop 模式行为必须完全不变。

## 2. 现状审计（精确数据，2026-08-01 实测）

- src-tauri 共 **163 个 .rs 文件**，其中 **54 个**引用 `tauri::`。
- 耦合分三类：

### 2.1 State 注入（Tauri command 标准签名）— 67 处 / 13 文件 / 11 种类型

| State 类型 | 处数 | 主要文件 |
|---|---|---|
| `Arc<GatewayController>` | 37 | commands/integration/gateway.rs (28), services/proxy.rs, services/gateway/* |
| `Arc<AutomationStore>` | 9 | commands/automation/cron.rs, hook.rs, settings/commands.rs |
| `Arc<McpRuntimeManager>` | 6 | commands/integration/mcp.rs |
| `Arc<GitCloneTaskRegistry>` | 4 | commands/workspace/git.rs |
| `Arc<HookScopeRegistry>` | 3 | commands/automation/hook.rs |
| `Arc<ProviderUsageService>` | 2 | commands/app/system.rs, settings/commands.rs |
| `Arc<PowerActivityManager>` | 2 | commands/app/system.rs |
| `Arc<TrayMenuHandles>` | 1 | commands/app/tray.rs（**桌面专用**） |
| `Arc<ShellRunRegistry>` | 1 | commands/runtime/shell.rs |
| `Arc<ProxyServerState>` | 1 | services/proxy.rs |
| `Arc<AutomationScheduler>` | 1 | commands/automation/cron.rs |

典型签名：
```rust
#[tauri::command]
pub async fn gateway_connect(
    payload: Option<Value>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> { ... }
```

**解耦方式**：`tauri::State<'_, Arc<X>>` → `&Arc<X>`。这是纯机械替换，`State::inner()` 的 deref 行为与 `&Arc<X>` 完全一致，方法调用处零改动。

### 2.2 AppHandle 持有 + emit — 12 个持有文件 / 28 处 emit

持有 AppHandle 的结构/函数：

| 文件 | 持有方式 | 用途 |
|---|---|---|
| services/gateway/mod.rs | `GatewayController.app_handle` 字段 | emit 网关状态事件 |
| services/gateway/controller.rs | 同 struct | `CHAT_HISTORY_SYNC_EVENT` 等 |
| services/gateway/connection.rs | `self.app_handle` | `gateway:*` 事件 ×2 |
| services/gateway/chat.rs | `self.app_handle` | 聊天事件 ×3 |
| services/gateway/chat_inbox.rs | `self.app_handle` | 收件箱事件 |
| services/gateway/envelope_handler.rs | `self.app_handle` | 设置同步 ×2 |
| services/gateway/chat_ingress.rs | `Option<AppHandle>` 字段 + spawn | 检查点事件 |
| services/automation/store.rs | `AutomationNotifier.app_handle` | cron/hook/prompt ×4 |
| services/tunnel/store.rs | `app_handle` 字段 | 隧道状态 |
| services/workspace_watch/mod.rs | `app_handle` 字段 | 工作区活动 |
| runtime/managed_process.rs | `pub app_handle` 字段 | 进程状态 |
| runtime/terminal/mod.rs + registry.rs | `Mutex<Option<AppHandle>>` | 终端事件 |
| commands/app/tray.rs | 命令参数 `app: tauri::AppHandle` | 托盘命令（桌面专用） |
| services/tray.rs | 函数参数 `&AppHandle` | 托盘菜单（桌面专用） |

28 处 emit 全部是**单向**（无 `.listen()`），事件名全部是字符串常量，载荷全部 `Serialize`。

**解耦方式**：定义 `EventEmitter` trait（见 §4.2），上述持有 `AppHandle` 的字段改为持有 `Arc<dyn EventEmitter>`。

### 2.4 补充耦合面（审计补齐，2026-08-01）

除 State/AppHandle 外，还有两个大面积耦合点（初版方案遗漏，已补入）：

| 耦合面 | 规模 | 位置 | 解耦方式 |
|---|---|---|---|
| `tauri::async_runtime::{spawn/spawn_blocking/block_on}` | **233 处 / 39 文件**（spawn_blocking 177、spawn 49、block_on 1） | 广布 commands/services/runtime | compat 模块别名 → `tokio::task::{spawn, spawn_blocking}` + `tokio::runtime::Handle`（见 §4.6） |
| `#[tauri::command]` 属性宏 | **234 处**（90 无参 + 144 带 `rename_all`） | 全部命令函数 | 业务函数去宏化 → desktop 适配层重新挂宏（见 §4.5） |

其余 tauri API（Wry×39 / Window×4 / Result×8 / App×3 / RunEvent×3 / tray×2 / Manager×2 / menu / image / generate_context / generate_handler / WindowEvent / Error / Builder / mobile_entry_point）**全部集中在 lib.rs + services/tray.rs + commands/app/app.rs** —— 桌面专有，headless 下整体 `#[cfg(feature = "desktop")]` 即可。

### 2.5 真实耦合面汇总（修正版）

| 耦合面 | 处数 | 文件数 | 解耦复杂度 |
|---|---|---|---|
| State 注入 | 67 | 13 | 低（机械替换 + 适配层） |
| async_runtime | 233 | 39 | 极低（compat 别名，纯 import 替换） |
| #[tauri::command] 宏 | 234 | ~40 | 中（去宏 + 适配层重新挂宏） |
| AppHandle 持有 + emit | 28 emit / 12 持有 | 14 | 低（EventEmitter trait） |
| 桌面专有模块 | — | 4（lib.rs/tray.rs/app.rs/system.rs） | 低（feature-gate） |



## 3. 架构设计

### 3.1 Cargo feature 设计

```toml
[features]
default = ["desktop"]
desktop = ["dep:tauri", "dep:tauri-plugin-opener", "dep:tauri-plugin-updater",
           "dep:tauri-plugin-window-state", "dep:tauri-plugin-global-shortcut",
           "dep:rfd", "dep:arboard", "dep:objc2-app-kit", "dep:windows-sys"]
headless = []   # 无 tauri 依赖，纯 axum + tokio

[dependencies]
tauri = { version = "2.11.5", features = ["tray-icon", "image-png"], optional = true }
tauri-plugin-opener = { version = "2.5.4", optional = true }
# ... 其余插件同样 optional
```

- `desktop` 依赖只在 `desktop` feature 下编译，headless 构建完全不触碰 GTK/WRY。
- `tauri-build`（build-dependencies）同样 feature-gate，否则 build script 会拉 tauri 上下文。

### 3.2 EventEmitter trait（核心抽象）

```rust
// src/events.rs
use serde::Serialize;

/// 事件发射抽象：desktop 实现转发到 Tauri webview，headless 实现广播到 WS 客户端。
pub trait EventEmitter: Send + Sync {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) -> Result<(), String>;
}

pub type SharedEventEmitter = Arc<dyn EventEmitter>;
```

- **desktop 实现** `TauriEventEmitter`：内部持 `tauri::AppHandle`，调 `app_handle.emit(...)`。
- **headless 实现** `WsEventEmitter`：内部持广播 channel（`tokio::sync::broadcast` 或连接池），序列化后推送。
- 持有方（§2.2 的 12 处）把 `tauri::AppHandle` 字段类型改为 `Arc<dyn EventEmitter>`，构造时注入。
- `tauri::Emitter` 的 `app_handle.emit()` 返回 `tauri::Result`，统一映射为 `Result<(), String>`（调用处已是 `if let Err` 模式，改动极小）。

### 3.3 State 注入解耦

- 所有命令函数签名：`tauri::State<'_, Arc<X>>` → `&Arc<X>`。
- 这要求命令**不再由 Tauri 自动注入**，而是显式传参。两种注册方式：
  - **desktop**：Tauri 的 `generate_handler!` 要求 `#[tauri::command]` 签名带 `tauri::State`。因此解耦后的命令需要**适配层**：
    ```rust
    // 适配层：desktop 侧薄封装，把 tauri::State 转为 &Arc<X> 再调真正的业务函数
    #[tauri::command]
    pub fn gateway_connect_adapter(
        payload: Option<Value>,
        gateway_controller: tauri::State<'_, Arc<GatewayController>>,
    ) -> Result<(), String> {
        crate::commands::gateway_connect(payload, gateway_controller.inner())
    }
    ```
    - **方案 A（推荐）**：业务函数改成普通函数（无 `#[tauri::command]`），desktop 适配层放 `#[tauri::command]` 薄壳。适配层集中在一个文件（`commands/adapters.rs`），用宏生成，约 200 行。
    - 方案 B：保留 `#[tauri::command]` + `tauri::State`，但把 body 委托给不带 tauri 的公共函数。等价但侵入更大。
  - **headless**：axum handler 直接调业务函数，从 `AppState`（`Arc<AppContext>`，持全部 `Arc<X>`）取引用传入。

### 3.4 lib.rs 拆分

```
lib.rs (原 831 行)
 ├─ run()                      → 派发到 run_desktop() / run_headless()
 ├─ run_desktop()  #[cfg(feature = "desktop")]   ← 原 run() 主体（tauri::Builder...）
 ├─ run_headless() #[cfg(feature = "headless")]  ← axum server + AppContext 装配
 ├─ AppContext                   ← 公共业务状态装配（原 run() 前 60 行）
 └─ app_invoke_handler!()        → 拆成 generate_handler! 调适配层
```

- **AppContext**：把业务状态（automation_store、memory_store、gateway_controller、各 registry……）统一装进一个 struct，两种模式共用装配逻辑。
- **desktop setup**：现状 `.setup()` 里做初始化 + `.manage(gateway_controller)`。重构为 setup 只做 tauri 专有部分（tray、window、plugins），业务初始化移到 AppContext::new()。
- **headless 启动流程**：
  1. `AppContext::new()`（业务初始化，与 desktop 完全一致）
  2. 启动 axum server（路由 = 全部命令的 JSON 映射，走 `commands/adapters.rs` 同源业务函数）
  3. `WsEventEmitter` 注入 AppContext 各组件
  4. `gateway_controller.start()`、`reload_from_db()`、各 registry spawn（与 desktop setup 相同）

### 3.5 命令注册（TS 侧）

- 现状：`src/lib/tools/invokeWithAbort.ts`（`import { invoke } from "@tauri-apps/api/core"`）+ `fsBackend.ts`，199 个唯一 invoke 命令名全部经这两文件路由。
- 解耦后 desktop 不变（适配层保证命令名不变）。
- headless 侧：新建 `invokeHeadless.ts`，同签名 `invoke(cmd, args)`，内部走 `fetch('/api/invoke', {cmd, args})`。前端通过环境变量/构建 flag 选择后端。**TS 改动单文件**（+fsBackend 对应实现）。

## 4. 逐文件改动清单

### 4.1 文件分级

- **A 级（纯机械，67 处 State 替换）**：13 个命令文件，签名行替换，零逻辑改动。
- **B 级（AppHandle→EventEmitter）**：12 个持有文件，字段类型 + 构造 + emit 调用微调。
- **C 级（桌面专有，feature-gate）**：lib.rs、services/tray.rs、commands/app/tray.rs、commands/app/app.rs、commands/app/update.rs 等。
- **D 级（新增）**：`events.rs`（trait）、`app_context.rs`（业务装配）、`adapters.rs`（desktop 适配层）、`headless.rs`（axum server）。

### 4.2 A 级清单（State 替换，13 文件）

| 文件 | 替换处数 | 备注 |
|---|---|---|
| commands/integration/gateway.rs | 28 | GatewayController |
| commands/automation/cron.rs | 9 | AutomationStore + AutomationScheduler |
| commands/integration/mcp.rs | 7 | McpRuntimeManager |
| commands/history/chat_history/commands.rs | 7 | 混合 |
| commands/workspace/git.rs | 4 | GitCloneTaskRegistry |
| commands/automation/hook.rs | 3 | HookScopeRegistry |
| commands/config/settings/commands.rs | 2 | AutomationStore + ProviderUsageService |
| commands/app/system.rs | 2 | PowerActivityManager + ProviderUsageService |
| commands/history/chat_history/{branch,delete,replace}.rs | 各1 | |
| commands/app/tray.rs | 1 | TrayMenuHandles（desktop only） |
| services/proxy.rs | 1 | ProxyServerState |

### 4.3 B 级清单（EventEmitter 注入，12 文件）

| 文件 | 改动 |
|---|---|
| services/gateway/mod.rs | `GatewayController.app_handle: tauri::AppHandle` → `Arc<dyn EventEmitter>` |
| services/gateway/controller.rs | 同 struct + emit 微调 |
| services/gateway/connection.rs / chat.rs / chat_inbox.rs / envelope_handler.rs | `self.app_handle.emit` → 类型已抽象 |
| services/gateway/chat_ingress.rs | `Option<AppHandle>` → `Option<Arc<dyn EventEmitter>>` + spawn 签名 |
| services/automation/store.rs | `AutomationNotifier.app_handle` 类型替换 |
| services/tunnel/store.rs | 字段类型 + `new()` 签名 |
| services/workspace_watch/mod.rs | 字段类型 + `new()` 签名 |
| runtime/managed_process.rs | `pub app_handle` 字段类型替换 |
| runtime/terminal/mod.rs + registry.rs | `Mutex<Option<AppHandle>>` → `Mutex<Option<Arc<dyn EventEmitter>>>` |

### 4.4 C 级清单（feature-gate，桌面专有）

| 文件 | 处理 |
|---|---|
| lib.rs | `run()` 拆分；`#![cfg(feature = "desktop")]` 包住 tauri Builder 部分 |
| services/tray.rs | 整体 `#[cfg(feature = "desktop")]` |
| commands/app/tray.rs | `#[cfg(feature = "desktop")]` |
| commands/app/update.rs | updater 相关 `#[cfg(feature = "desktop")]` |
| commands/app/app.rs | window 操作相关 |
| Cargo.toml | tauri 系依赖全 optional + feature |

### 4.5 D 级清单（新增）

| 文件 | 内容 |
|---|---|
| src/events.rs | `EventEmitter` trait + `TauriEventEmitter`(desktop) + `WsEventEmitter`(headless) |
| src/compat.rs | `async_runtime` 兼容别名（见 §4.6） |
| src/app_context.rs | `AppContext` struct + `new()`（业务状态装配，从 lib.rs run() 提取） |
| src/adapters.rs | desktop 命令适配层（`#[tauri::command]` 薄壳，宏生成） |
| src/headless.rs | axum server：路由注册、AppState、JSON-RPC handler、WS 事件广播 |

### 4.6 async_runtime 兼容层（新增，233 处替换）

`tauri::async_runtime` 是 tokio 的薄封装，语义完全等价。新建 `src/compat.rs`：

```rust
// src/compat.rs
pub mod async_runtime {
    /// spawn: tauri::async_runtime::spawn ≡ tokio::spawn
    pub use tokio::task::spawn;
    /// spawn_blocking: 语义等价（tokio 同 API）
    pub use tokio::task::spawn_blocking;
    /// block_on: 需在 tokio runtime 上下文内调用（tauri 内部同样基于 tokio）
    pub fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Handle::current().block_on(fut)
    }
}
```

替换方式：39 个文件里 `tauri::async_runtime::spawn(...)` → `crate::compat::async_runtime::spawn(...)`，纯机械替换（脚本批量）。**行为零变化**（tauri 2.x 的 async_runtime 就是 tokio runtime 代理）。

### 4.7 命令去宏化 + 适配层（234 处）

**业务命令函数**（现状）：
```rust
#[tauri::command]
pub async fn gateway_connect(
    payload: Option<Value>,
    gateway_controller: tauri::State<'_, Arc<GatewayController>>,
) -> Result<(), String> { ... }
```

**解耦后业务函数**（无 tauri 依赖，可被 desktop/headless 共用）：
```rust
pub async fn gateway_connect(
    payload: Option<Value>,
    gateway_controller: &Arc<GatewayController>,
) -> Result<(), String> { ... }
```

**desktop 适配层**（adapters.rs，宏生成薄壳，仅参数转发）：
```rust
#[tauri::command]
pub async fn gateway_connect_adapter(
    payload: Option<Value>,
    state: tauri::State<'_, Arc<AppContext>>,
) -> Result<(), String> {
    crate::commands::gateway_connect(payload, &state.inner().gateway_controller).await
}
```

- 适配层文件按模块组织（gateway.rs / automation.rs / workspace.rs …），总代码量约 700 行（234 命令 × ~3 行），全部机械生成。
- `invoke_handler` 注册的是 `*_adapter`，命令名保持原样（`rename_all` 规则继承）。
- **headless**：axum handler 调业务函数（`crate::commands::gateway_connect`），从 `AppState.ctx` 取 `&Arc<X>`。

> 备选：不动业务函数（保留 `#[tauri::command]` + State），用 `#[cfg]` 双实现。否决——业务代码带 tauri 依赖违反解耦目标，且 headless 下无法编译。

## 5. 依赖处理

```toml
# 保留（两种模式共用）
axum, tokio, tokio-stream, tokio-tungstenite, reqwest, futures-util, uuid,
base64, globset, lopdf, regex, thiserror, walkdir, notify, dirs, toml, ignore,
rusqlite, leveldb-core, chrono, tokio-cron-scheduler, rustls, prost, zip, sha2,
zstd, tempfile, semver, quick-xml, portable-pty, wait-timeout, russh, russh-sftp,
encoding_rs, chardetng, serde, serde_json, rquickjs, percent-encoding

# 移到 desktop feature（optional）
tauri, tauri-plugin-opener, tauri-plugin-updater, tauri-plugin-window-state,
tauri-plugin-global-shortcut, tauri-plugin-mcp-bridge, tauri-build,
rfd, arboard, objc2-app-kit(macos), windows-sys(windows)
```

> 注：`tauri-plugin-mcp-bridge` 是否 desktop-only 需复查——若 MCP bridge 是业务功能（MCP server 供外部连接），headless 可能仍需等价能力，届时用 axum 实现 MCP over HTTP，不算 Tauri 依赖。

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 67 处 State 替换破坏命令签名 → desktop 行为变化 | 中 | 适配层保证命令名/签名不变；desktop 完整回归（前端 199 个 invoke 逐一可用） |
| `tauri::async_runtime::spawn` 替换为 tokio 后线程模型差异 | 低 | 两者都是 tokio 运行时；tauri 用 `spawn_blocking` 处同步替换 `tokio::task::spawn_blocking` |
| AppHandle 持有类型改动侵入多个构造链 | 中 | B 级文件 12 个，逐个编译验证；构造点集中在 lib.rs setup，改动可控 |
| MCP bridge 依赖不明确 | 低 | 复查后决定 desktop-only 或 headless 等价实现 |
| build.rs（tauri-build）在 headless 下误跑 | 中 | build-dependencies feature-gate + 条件跳过 |
| `generate_context!` 宏要求 frontendDist 存在 | 低 | desktop-only；headless 不调用 |
| 改动量大致回推困难 | 中 | 按 PR 拆分（见 §8），每 PR 独立可编译可测试 |

## 7. 验证策略

1. **每步编译**：`cargo check --features desktop` 与 `cargo check --features headless` 双通道。
2. **desktop 回归**：`cargo build`（desktop）+ 前端跑通 199 命令冒烟（抽样 gateway/terminal/fs 类）。
3. **headless 冒烟**：`cargo run --features headless` 起服务 → curl 健康检查 → 调 2-3 个业务命令（如 `fs_read`、`gateway_status`）。
4. **P0 脚本回归**：`/tmp/la-min-agent.mjs` 不受影响（纯 Node 侧）。
5. **回推前**：`cargo clippy` + `cargo test`（若有）全绿。

## 8. 里程碑与回推 PR 拆分

### P1.1 纯重构（本阶段，不引入 headless binary）
1. **PR-A：EventEmitter 抽象 + compat 层**（events.rs + compat.rs + 12 文件 AppHandle 替换 + 39 文件 async_runtime 替换）— 可回推，desktop 行为不变
2. **PR-B：State 解耦 + 命令去宏化**（13 文件签名替换 + 234 命令去 `#[tauri::command]` + adapters.rs）— 可回推
3. **PR-C：lib.rs 拆分**（AppContext 提取 + run() 派发 + 桌面专有模块 feature-gate）— 可回推（gate 部分谨慎）

### P1.2 headless 化（下一步）
4. **PR-D：Cargo feature gate**（tauri 系 optional）— 回推需谨慎（上游可能不想要 feature），作为 fork 私有提交
5. **PR-E：headless binary**（axum server + WsEventEmitter + TS 桥接）

### 回推策略
- PR-A/B/C 是**纯附加式重构**（不改行为），可回推上游，降低 fork 漂移成本。
- PR-D/E 是 fork 私有（headless 是 LiveAgent 无的需求），但 PR-D 的 feature-gate 设计可作 PR 提议（optional deps 对上游是低风险增强）。

## 9. 完成定义（Definition of Done）

- [ ] `cargo check --features desktop` 通过（无 warning 新增）
- [ ] `cargo check --features headless` 通过（无 tauri 依赖）
- [ ] desktop 构建产物可启动，托盘/窗口/终端/网关抽样功能正常
- [ ] headless 构建产物可启动，axum /health + 抽样命令正常
- [ ] 业务文件（A/B 级）不再 import `tauri::`（桌面专有模块除外）
- [ ] 233 处 async_runtime 全部走 compat 层
- [ ] 234 个命令函数全部去 `#[tauri::command]`（desktop 经适配层注册）
- [ ] 28 处 emit 全部经 EventEmitter trait
- [ ] 前端 199 个 invoke 命令名在 desktop 下全部可用（抽样冒烟）

## 10. 工作量估算（修正版）

| 工作项 | 文件 | 预估 |
|---|---|---|
| compat 层（async_runtime 替换） | 39 文件 | 0.5 天（脚本机械替换 + 编译修错） |
| EventEmitter 抽象 | 12 持有 + 2 新增 | 1 天 |
| State 解耦 + 命令去宏化 | 13 + 234 命令 + 适配层 | 2~3 天 |
| lib.rs 拆分 + AppContext | 1 + 1 新增 | 1 天 |
| feature-gate（Cargo.toml + 4 桌面文件） | 6 | 1 天 |
| headless binary（axum + WS 广播 + TS 桥接） | 3 新增 + TS 2 | 2~3 天 |
| 验证（desktop 回归 + headless 冒烟 + clippy） | — | 1~2 天 |
| **合计** | — | **8~11 天**（单人） |
